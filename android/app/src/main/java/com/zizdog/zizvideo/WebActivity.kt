package com.zizdog.zizvideo

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.os.Bundle
import android.os.IBinder
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
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import androidx.activity.enableEdgeToEdge
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

        /** 启动时直接打开的站内路径（如 "/#/favorites/later"）；不传就进首页。 */
        const val EXTRA_PATH = "path"

        /** 启动即拉起系统文件选择器（zizvideo://upload 快捷方式用）。 */
        const val EXTRA_PICK = "pick_uploads"
    }

    private lateinit var web: WebView
    private lateinit var fullscreen: FrameLayout
    private var base: String = ""
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var launchingNative = false
    private var handlingLogin = false

    /**
     * 记住最近一次搜索词：网页里点搜索结果会跳到 #/play/search/<id>，这个地址**不带关键词**，
     * 而网页那份结果是内存里的临时缓存，原生拿不到。所以在它还在 #/search/<q> 时先记下来，
     * 点进结果时用 ?q= 自己重放同一份列表（仍然是服务端同一个筛选接口，不另立契约）。
     */
    private var lastSearchQuery = ""

    // 连一个 MediaController：media3 靠"有没有控制器"判断会话在用，进而发媒体通知 + 提升前台服务。
    // 少了它，交接路径下服务不进前台（startForegroundCount:0、通知栏没有媒体卡片），后台就不算稳定（实测踩过）。
    private var mediaFuture: ListenableFuture<MediaController>? = null

    /** 网页调这个：它在后台了，把**它当前那份队列 + 正在播的那条 + 位置**整体交出来。 */
    /** 交接时记下"交出的是哪一条"：回前台时只有同一条才续播（否则位置属于别的剧集，会整集乱跳）。 */
    private var handedOffId = ""

    inner class Bridge {
        /** 网页一开播就预热（不退后台也调），交接时就不用现拉流。 */
        /**
         * 网页的「旋转全屏」调这个：真·系统横屏（不依赖用户开自动旋转）。
         * 网页拿不到这个桥（老版本 App）时会退回 CSS 自己转 90°，所以这里必须如实返回是否接管。
         */
        @android.webkit.JavascriptInterface
        fun landscape(on: Boolean): Boolean {
            runOnUiThread {
                requestedOrientation = if (on) {
                    ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                } else {
                    ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                }
            }
            return true
        }

        /** 网页「用系统选择器上传」调这个：SAF 多选视频，交给 UploadService 后台传（息屏不断）。 */
        @android.webkit.JavascriptInterface
        fun pickUploads(): Boolean {
            runOnUiThread {
                try {
                    uploadPicker.launch(arrayOf("video/*"))
                } catch (e: Exception) {
                    android.widget.Toast.makeText(this@WebActivity, "打不开系统选择器：" + e.message,
                        android.widget.Toast.LENGTH_LONG).show()
                }
            }
            return true
        }

        @android.webkit.JavascriptInterface
        fun prepare(payload: String) {
            val service = PlaybackService.instance ?: return
            val p = parsePayload(payload) ?: return
            service.prepareItems(p.ids, p.titles, p.index)
        }

        @android.webkit.JavascriptInterface
        fun handOff(payload: String) {
            val service = PlaybackService.instance ?: return
            val ids = ArrayList<String>()
            val titles = ArrayList<String>()
            var index = 0
            var positionMs = 0L
            try {
                val obj = org.json.JSONObject(payload)
                val arr = obj.optJSONArray("ids") ?: return
                val tarr = obj.optJSONArray("titles")
                for (i in 0 until arr.length()) {
                    ids.add(arr.optString(i))
                    titles.add(tarr?.optString(i) ?: "")
                }
                index = obj.optInt("index")
                positionMs = obj.optLong("positionMs")
            } catch (e: Exception) {
                return
            }
            if (ids.isEmpty()) return
            handedOffId = ids[index.coerceIn(0, ids.size - 1)]
            runOnUiThread { service.playItems(ids, titles, index, positionMs) }
        }
    }

    private class Payload(val ids: List<String>, val titles: List<String>, val index: Int, val positionMs: Long)

    private fun parsePayload(payload: String): Payload? = try {
        val obj = org.json.JSONObject(payload)
        val arr = obj.optJSONArray("ids") ?: return null
        val tarr = obj.optJSONArray("titles")
        val ids = ArrayList<String>()
        val titles = ArrayList<String>()
        for (i in 0 until arr.length()) {
            ids.add(arr.optString(i))
            titles.add(tarr?.optString(i) ?: "")
        }
        if (ids.isEmpty()) null else Payload(ids, titles, obj.optInt("index"), obj.optLong("positionMs"))
    } catch (e: Exception) {
        null
    }

    /**
     * 注入的钩子（不改网页仓库）：页面隐藏且**真的在播**时，把 media id 与位置交给原生。
     * 交完立刻暂停网页那个 video，避免两路声音；原生那边有 MediaSession+前台服务，后台/锁屏都稳。
     */
    private val hookScript = """
        (function () {
          if (window.__zvHooked) return; window.__zvHooked = true;
          function idOf(v) {
            var src = v.getAttribute('src') || '';
            var i = src.indexOf('/media/');
            if (i < 0) return '';
            return src.substring(i + 7).split('/')[0];
          }
          function titleOf(v) {
            var shell = v.closest('article.card') || v.parentElement;
            var t = shell ? shell.querySelector('.ov-title') : null;
            return t ? (t.textContent || '').trim() : '';
          }
          function payload() {
            var vs = [].slice.call(document.querySelectorAll('video'));
            var ids = [], titles = [], index = -1, positionMs = 0;
            for (var i = 0; i < vs.length; i++) {
              var id = idOf(vs[i]);
              if (!id) continue;
              if (!vs[i].paused && index < 0) {
                index = ids.length;
                positionMs = Math.round((vs[i].currentTime || 0) * 1000);
              }
              ids.push(id);
              titles.push(titleOf(vs[i]));
            }
            return index < 0 ? null : { ids: ids, titles: titles, index: index, positionMs: positionMs };
          }
          // 一开播就预热原生播放器：退后台时不用现拉流，不会"卡一下"
          document.addEventListener('play', function () {
            var p = payload();
            if (!p || !window.ZvAndroid || !window.ZvAndroid.prepare) return;
            try { ZvAndroid.prepare(JSON.stringify(p)); } catch (e) {}
          }, true);
          document.addEventListener('visibilitychange', function () {
            if (document.visibilityState !== 'hidden') return;
            var p = payload();
            if (!p || !window.ZvAndroid) return;
            try { ZvAndroid.handOff(JSON.stringify(p)); } catch (e) { return; }
            window.__zvHandedOff = p.ids[p.index];
            try {
              [].slice.call(document.querySelectorAll('video')).forEach(function (v) { v.pause(); });
            } catch (e) {}
          });
        })();
    """.trimIndent()
    private var pickOnLoad = false
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    // 用户上传：SAF 多选 → 交给前台服务后台传（网页端那套分片接口）
    private val uploadPicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val list = ArrayList(uris ?: emptyList())
        if (list.isEmpty()) return@registerForActivityResult
        for (uri in list) {
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (e: Exception) {
                // 有些 provider 不给持久授权：临时授权在服务存活期间仍可读，读失败会如实报错
            }
        }
        UploadService.start(this, list)
    }

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        callback.onReceiveValue(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_web)
        Ui.padSystemBars(findViewById(R.id.root))
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
        web.addJavascriptInterface(Bridge(), "ZvAndroid")
        // 前台时先把服务"启动"起来（此时不受后台启动限制），后面在后台才能提升为前台服务
        // 前台时先把服务起起来（此时不受后台启动限制）+ 连一个控制器（见 mediaFuture 的说明）
        startService(Intent(this, PlaybackService::class.java))
        mediaFuture = MediaController.Builder(
            this, SessionToken(this, ComponentName(this, PlaybackService::class.java)),
        ).buildAsync()
        val path = intent.getStringExtra(EXTRA_PATH)?.takeIf { it.startsWith("/") } ?: "/#/feed"
        pickOnLoad = intent.getBooleanExtra(EXTRA_PICK, false)
        web.loadUrl(base + path)

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
            override fun onPageFinished(v: WebView, url: String?) {
                v.evaluateJavascript(hookScript, null)
                if (pickOnLoad) {
                    pickOnLoad = false
                    // 等页面画完再弹选择器：用户能看到"在上传页"的上下文
                    v.postDelayed({ try { uploadPicker.launch(arrayOf("video/*")) } catch (e: Exception) { } }, 400)
                }
            }

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
        val segs = hash.split("/").filter { it.isNotEmpty() }
        if (segs.size >= 2 && segs[0] == "search") {
            lastSearchQuery = android.net.Uri.decode(segs[1])
            return false
        }
        // 会话失效时网页会退到 #/login：把用户交回原生登录页（那里会重新登录并把新 cookie 灌进来），
        // 否则他在网页里重登、原生播放器还拿着旧 cookie 一直 401。
        if (hash == "/login") {
            if (!handlingLogin) {
                handlingLogin = true
                startActivity(Intent(this, LoginActivity::class.java))
                finish()
            }
            return true
        }
        val parts = hash.split("/").filter { it.isNotEmpty() }
        if (parts.size < 3 || parts[0] != "play") return false
        val kind = parts[1]
        if (kind !in ZvApi2.supportedKinds) return false
        // search：没有记住关键词就没法重建队列，这时留给网页播放器（前台可用，后台不听），别假装能后台
        if (kind == "search" && lastSearchQuery.isBlank()) return false
        if (launchingNative) return true
        launchingNative = true
        startActivity(
            Intent(this, PlayerActivity::class.java)
                .putExtra(PlayerActivity.EXTRA_KIND, kind)
                .putExtra(PlayerActivity.EXTRA_MEDIA_ID, android.net.Uri.decode(parts[2]))
                .putExtra(PlayerActivity.EXTRA_QUERY, if (kind == "search") lastSearchQuery else ""),
        )
        web.post {
            if (web.canGoBack()) web.goBack()
            web.postDelayed({ launchingNative = false }, 1500)
        }
        return true
    }

    override fun onResume() {
        super.onResume()
        // 回来时把播放从原生收回网页：同一条、同一位置，网页那边界面/按钮/进度都对得上
        val service = PlaybackService.instance ?: return
        val cur = service.current() ?: return
        val (mediaId, positionMs) = cur
        service.stopPlayback()
        // 原生可能已经连播到下一集：那这个位置属于**另一条**，拿它去 seek 当前这条就会"整集乱跳"
        // （用户 2026-09-23 报障）。所以只在同一条上续播；不同条就保持网页原样，并如实说一句。
        if (mediaId != handedOffId) {
            android.widget.Toast.makeText(this, "后台已播到别的剧集，已收回播放", android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        // 按"刚交出去的那条"恢复（不是按原生当前条：它可能已经连播到下一条了），位置超长就钳到本条时长里
        val js = "(function(){var want=window.__zvHandedOff||'';var vs=document.querySelectorAll('video');" +
            "var v=null;for(var i=0;i<vs.length;i++){var src=vs[i].getAttribute('src')||'';" +
            "if(want&&src.indexOf('/media/'+want+'/stream')>=0){v=vs[i];break;}}" +
            "if(!v)return;try{var d=v.duration||0;var t=" + (positionMs / 1000.0) + ";" +
            "if(d>0&&t>d-1)t=0;v.currentTime=t;}catch(e){}try{v.play();}catch(e){}})();"
        web.evaluateJavascript(js, null)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush() // 会话 cookie 落盘，重启免登录
    }

    override fun onDestroy() {
        mediaFuture?.let { MediaController.releaseFuture(it) }
        // 全屏视频要先收干净，否则会漏一个 SurfaceView
        customView?.let { fullscreen.removeView(it) }
        web.destroy()
        super.onDestroy()
    }

}
