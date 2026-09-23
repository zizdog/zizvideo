package com.zizdog.zizvideo

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/**
 * 网页界面宿主：zizvideo 的**全部操作**都用现成网页（用户 2026-09-23："操作用网页端的现成方案"）。
 * 这里只补安卓必须有、网页给不了的东西：
 *   · 返回键 → 网页历史（到底了再按一次退出）
 *   · 网页全屏视频（onShowCustomView）
 *   · 后台"上传"要的文件选择器
 *   · 外链走系统浏览器；自签 HTTPS 证书让用户自己决定要不要继续
 * 原生播放页（后台听视频）在下一步接（见 README 的路线）。
 */
class WebActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_BASE = "base"
    }

    private lateinit var web: WebView
    private lateinit var fullscreen: FrameLayout
    private var base: String = ""
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var launchingNative = false
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        callback.onReceiveValue(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_web)
        web = findViewById(R.id.web)
        fullscreen = findViewById(R.id.fullscreen)
        base = intent.getStringExtra(EXTRA_BASE) ?: Prefs(this).baseUrl
        if (base.isBlank()) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        CookieManager.getInstance().setAcceptCookie(true)
        configure(web)
        web.loadUrl("$base/#/feed")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> customViewCallback?.onCustomViewHidden()
                    web.canGoBack() -> web.goBack()
                    else -> finish()
                }
            }
        })
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(view: WebView) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = false // 首页是静音自动播，别被手势策略拦下
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = "$userAgentString zizvideo-android/0.1"
        }
        view.setBackgroundColor(0xFF101014.toInt())
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                // 站内（同 host）继续在 WebView 里走；其它一律交给系统浏览器，别把网页壳当浏览器用。
                if (url.toString().startsWith(base)) return handlePlayRoute(url.toString())
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (e: ActivityNotFoundException) {
                    true
                }
            }

            /** 网页里点「收藏/历史/稍后再看」的卡片 = 同文档 hash 跳转，只能从这里截；截住后交原生播。 */
            override fun doUpdateVisitedHistory(v: WebView, url: String?, isReload: Boolean) {
                if (url != null) handlePlayRoute(url)
            }

            override fun onReceivedSslError(v: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
                // 局域网自签证书很常见：不静默放行，也不直接掐死，让用户自己决定。
                AlertDialog.Builder(this@WebActivity)
                    .setTitle("证书不受信任")
                    .setMessage("${error.url}\n\n继续可能被中间人窃听。只有你自己的服务器才该继续。")
                    .setPositiveButton("继续") { _, _ -> handler.proceed() }
                    .setNegativeButton("取消") { _, _ -> handler.cancel() }
                    .setCancelable(false)
                    .show()
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                v: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    filePicker.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                fullscreen.addView(view)
                fullscreen.visibility = View.VISIBLE
                web.visibility = View.GONE
            }

            override fun onHideCustomView() {
                customView?.let { fullscreen.removeView(it) }
                fullscreen.visibility = View.GONE
                web.visibility = View.VISIBLE
                customView = null
                customViewCallback = null
            }
        }
    }

    /**
     * 网页深链 #/play/<kind>/<id> → 原生播放器（kind 只认服务端有据可查的四种）。
     * 处理完让网页**退回上一页**（通常就是那个列表页）：不这么做，网页播放器会在后台继续放，
     * 跟原生播放器两路声音；退回去之后网页那边自然收声，用户回来时还停在列表上，更好挑下一条。
     */
    private fun handlePlayRoute(url: String): Boolean {
        val hash = url.substringAfter("#", "")
        val parts = hash.split("/").filter { it.isNotEmpty() }
        if (parts.size < 3 || parts[0] != "play") return false
        val kind = parts[1]
        if (kind !in ZvApi2.supportedKinds) return false // search 是网页临时队列：留给网页播放器
        if (launchingNative) return true
        launchingNative = true
        startActivity(
            Intent(this, PlayerActivity::class.java)
                .putExtra(PlayerActivity.EXTRA_KIND, kind)
                .putExtra(PlayerActivity.EXTRA_MEDIA_ID, android.net.Uri.decode(parts[2])),
        )
        web.post {
            if (web.canGoBack()) web.goBack()
            web.postDelayed({ launchingNative = false }, 1500)
        }
        return true
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush() // 会话 cookie 落盘，重启免登录
    }

    override fun onDestroy() {
        // 全屏视频要先收干净，否则会漏一个 SurfaceView
        customView?.let { fullscreen.removeView(it) }
        web.destroy()
        super.onDestroy()
    }

}
