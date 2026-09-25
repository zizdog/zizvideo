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

        /** 强制按电视端启动（自测/模拟器用：`--ez tv true`）；真机电视自动判定，不用传。 */
        const val EXTRA_TV = "tv"

        /** 覆盖更新源（自测/模拟器用：`--es update_base http://10.0.2.2:17802/apps/zizvideo`）。 */
        const val EXTRA_UPDATE_BASE = "update_base"

        /**
         * 是不是电视/盒子（用户 2026-09-25）：Android TV 的 UI 模式，或系统带 leanback 特性。
         * 判据用它而不是 Build.MODEL 猜：盒子/电视/投影都算，手机平板都不算。
         */
        fun isTv(context: Context): Boolean {
            try {
                val ui = context.getSystemService(Context.UI_MODE_SERVICE) as android.app.UiModeManager
                if (ui.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION) return true
            } catch (e: Exception) {
                // 拿不到 UiModeManager 就退回特性判定
            }
            return context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK)
        }
    }

    private lateinit var web: WebView
    private lateinit var fullscreen: FrameLayout
    private var base: String = ""
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var launchingNative = false
    private var handlingLogin = false

    /** 更新源地址（默认镜像站；自测可覆盖）与"这个进程里已经提示过一次更新"的标记。 */
    private var updateBase: String = Updater.DEFAULT_BASE
    private var updatePrompted = false

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

        /**
         * B4：网页的「画中画」按钮要求把整个 App 缩成浮窗（WebView 里的视频继续放）。
         * 网页拿不到这个桥（浏览器/老版本 App）时会退回标准的 requestPictureInPicture()。
         */
        @android.webkit.JavascriptInterface
        fun enterPip(): Boolean {
            runOnUiThread {
                try {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        // 宽高比按当前窗口算：竖屏刷视频就是竖窗，横屏播放就是横窗
                        val w = web.width.takeIf { it > 0 } ?: 16
                        val h = web.height.takeIf { it > 0 } ?: 9
                        val params = android.app.PictureInPictureParams.Builder()
                            .setAspectRatio(android.util.Rational(w, h))
                            .build()
                        enterPictureInPictureMode(params)
                    } else {
                        android.widget.Toast.makeText(this@WebActivity, "这台机器（安卓 8 以下）不支持画中画",
                            android.widget.Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    android.widget.Toast.makeText(this@WebActivity, "开不了画中画：" + e.message,
                        android.widget.Toast.LENGTH_LONG).show()
                }
            }
            return true
        }

        /** 老的缓存口（只有标题）：新网页优先用下面的 cacheVideo2。 */
        @android.webkit.JavascriptInterface
        fun cacheVideo(mediaId: String, title: String): Boolean {
            if (mediaId.isBlank()) return false
            runOnUiThread {
                val id = OfflineStore.enqueue(this@WebActivity, base, mediaId, title)
                if (id < 0) {
                    android.widget.Toast.makeText(this@WebActivity, "开始缓存失败（看通知栏或稍后再试）",
                        android.widget.Toast.LENGTH_LONG).show()
                } else {
                    android.util.Log.i("zv-offline", "web cache id=" + mediaId)
                }
            }
            return true
        }

        /**
         * 网页的「缓存视频」（带元数据）：metaJson = {id,title,cover,duration_ms}，
         * 与文件一起落盘 ⇒「我的 → 已缓存」离线也能显示标题和封面（用户 2026-09-25 报障：
         * 之前只存 id，列表里就是一串看不出标题的字符串、还没有预览）。
         */
        @android.webkit.JavascriptInterface
        fun cacheVideo2(mediaId: String, metaJson: String): Boolean {
            if (mediaId.isBlank()) return false
            runOnUiThread {
                val title = try { org.json.JSONObject(metaJson).optString("title") } catch (e: Exception) { "" }
                val id = OfflineStore.enqueue(this@WebActivity, base, mediaId, title, metaJson)
                if (id < 0) {
                    android.widget.Toast.makeText(this@WebActivity, "开始缓存失败（看通知栏或稍后再试）",
                        android.widget.Toast.LENGTH_LONG).show()
                } else {
                    android.util.Log.i("zv-offline", "web cache id=" + mediaId)
                }
            }
            return true
        }

        /** 网页「我的 → 已缓存」要的清单：JSON 数组 [{id,size,title,cover,duration_ms}]。 */
        @android.webkit.JavascriptInterface
        fun listCached(): String {
            return OfflineStore.listJson(this@WebActivity)
        }

        /** 删掉某一集的离线缓存（只删手机上的文件）。 */
        @android.webkit.JavascriptInterface
        fun deleteCached(mediaId: String): Boolean {
            if (mediaId.isBlank()) return false
            return OfflineStore.delete(this@WebActivity, mediaId)
        }

        /**
         * 诊断某一集的下载状态（系统 DownloadManager 的 status/reason/进度 + 失败原因）。
         * 为什么留着它：点「缓存」没反应时，只有这个能说清"卡在哪"（上一轮查这个问题查了很久）。
         */
        @android.webkit.JavascriptInterface
        fun cachedRaw(mediaId: String): String {
            if (mediaId.isBlank()) return ""
            val raw = OfflineStore.rawStatus(this@WebActivity, mediaId)
            val why = OfflineStore.failReason(this@WebActivity, mediaId)
            return if (why != null) raw + " | " + why else raw
        }

        /** 网页「我的」显示 App 版本（服务端版本是另一个号，别混）。 */
        @android.webkit.JavascriptInterface
        fun appVersion(): String = Updater.appVersion(this@WebActivity)

        /** 网页点「检查更新」：interactive=true 时"已是最新"也要说一句（自动检查时不打扰）。 */
        @android.webkit.JavascriptInterface
        fun checkUpdate(interactive: Boolean): Boolean {
            runOnUiThread { this@WebActivity.checkUpdate(interactive) }
            return true
        }

        /** 网页进入/退出全屏（沉浸态）时告知原生：返回手势要据此先退出全屏。 */
        @android.webkit.JavascriptInterface
        fun setImmersive(on: Boolean) {
            webImmersive = on
        }

        /** 网页问"这是不是电视"：遥控器导航（js/tv.js）据此开关（真判据在 isTv()）。 */
        @android.webkit.JavascriptInterface
        fun isTv(): Boolean = tvMode

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

    /** 电视端（Android TV / 盒子）：网页据此走遥控器导航（?tv=1）。 */
    private var tvMode = false

    /** 网页是否处于全屏（沉浸）态：系统返回手势要先退出全屏，而不是直接导航/退出。 */
    private var webImmersive = false
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
        // 更新源：默认镜像站，自测可用 update_base 覆盖（真机上没有这个参数）
        updateBase = intent.getStringExtra(EXTRA_UPDATE_BASE)?.takeIf { it.startsWith("http") }
            ?: Updater.DEFAULT_BASE
        // 带 ?zv=app：告诉前端"原生已经垫过系统栏"，别再叠加 safe-area（见 Ui.padSystemBars）
        // 电视端再多带 ?tv=1：前端走遥控器导航（js/tv.js，方向键落焦 + 播放页按键语义）
        val tv = intent.getBooleanExtra(EXTRA_TV, false) || isTv(this)
        tvMode = tv
        val flag = if (tv) "?zv=app&tv=1" else "?zv=app"
        val flagged = if (path.contains("#")) path.replaceFirst("#", flag + "#") else path + flag
        val url = base + flagged
        android.util.Log.i("zv-nav", "loadUrl=$url tv=$tv")
        // 电视端：按键事件要落到 WebView 上（遥控器没有触摸，没人帮它 requestFocus）
        if (tv) {
            web.isFocusable = true
            web.isFocusableInTouchMode = true
            web.requestFocus()
        }
        web.loadUrl(url)
        // 自动检查更新：进 App 顺手查一次（已是最新/连不上都**不打扰**），有新版本才弹窗。
        // 延迟几秒：别跟首屏抢带宽和注意力。
        web.postDelayed({ checkUpdate(false) }, 3000)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> customViewCallback?.onCustomViewHidden()
                    else -> {
                        // 返回手势先问网页（用户 2026-09-24）：
                        //   ① 有设置面板/选集面板开着 ⇒ 只关面板（播放内容不动）；
                        //   ② 在全屏 ⇒ 退全屏；
                        //   ③ 都没有 ⇒ 交给下面的路由逻辑（返回上一页/退出）。
                        // 注意顺序：先问 __zvBackHandler；老版本网页没有它时退回 __zvExitFullscreen。
                        web.evaluateJavascript(
                            "(function(){var h=window.__zvBackHandler||window.__zvExitFullscreen;" +
                                "return h?h():false;})()") { result ->
                            val consumed = result == "true"
                            if (!consumed) {
                                if (web.canGoBack()) web.goBack() else finish()
                            }
                        }
                    }
                }
            }
        })
    }

    /**
     * 电视端遥控器的「菜单」键：实测 WebView 不一定把它交给网页（网页里收不到 keydown）⇒
     * 原生自己接住，让网页打开设置面板（网页侧在 tv 模式下注册 window.__zvTvMenu）。
     * 其它按键一律不拦：方向键/确定由网页的遥控器导航处理（js/tv.js）。
     */
    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent?): Boolean {
        if (tvMode && keyCode == android.view.KeyEvent.KEYCODE_MENU) {
            web.evaluateJavascript("(function(){var f=window.__zvTvMenu;return f?f():false;})()", null)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(view: WebView) {        // 只有"可调试"的包开远程调试：自测（模拟器 + adb forward）要靠它读网页里的真实状态。
        // release 包绝不开 —— 那等于把调试端口暴露给同机的任何程序。
        val debuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = false // 首页是静音自动播，别被手势策略拦下
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = "$userAgentString zizvideo-android/0.1"
            // 视口/缩放（用户 2026-09-24 报障："app 里小窗恢复后整个画面被放大、超出屏幕且回不来"）：
            // 小窗时窗口变小，WebView 若按"整页概览"重算就会留下一个放大的 scale，退出后不还原。
            // 这里明确按 viewport meta 排版、禁止缩放，避免它自己有想法。
            useWideViewPort = true
            loadWithOverviewMode = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
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

    /** B4：进出小窗时通知网页，好让「画中画」按钮的点亮状态和真实情况一致。 */
    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        try {
            // 退出小窗要**彻底复位**：小窗里的窗口尺寸会让 WebView 留下初始缩放，
            // 不复位就是"画面被放大、超出屏幕、按钮跑到屏幕外"（用户 2026-09-24 报障）。
            if (!isInPictureInPictureMode) {
                web.setInitialScale(0)
                web.post {
                    web.requestLayout()
                    web.evaluateJavascript(
                        "(function(){try{window.scrollTo(0,0);}catch(e){}" +
                            "if(window.zvPipMode)window.zvPipMode(false);})()", null)
                }
            } else {
                web.evaluateJavascript("window.zvPipMode&&window.zvPipMode(true)", null)
            }
        } catch (e: Exception) {
            // 页面还没加载好就算了，状态会在下一次回调对齐
        }
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

    /**
     * 窗口重新拿到焦点（App 回前台/退出小窗）时，请网页把"被浏览器策略摁成静音"的那次恢复回来。
     * 为什么 App 能自动恢复、网页不能：这里设了 mediaPlaybackRequiresUserGesture=false，
     * 页面可见就该允许有声；网页端浏览器一定要用户手势，只能由用户点喇叭。
     * （用户 2026-09-25 报障：图标显示有声却没声，得点两下才有声音 —— 网页侧已改成图标跟着实际走，
     *   App 侧再补这一下自动恢复。）
     */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || !::web.isInitialized) return
        web.evaluateJavascript(
            "(function(){var f=window.__zvSoundNudge;return f?f():false;})()") { r ->
            // 结果落日志：true = 这次确实被策略摁过静音、已自动恢复；false = 没被摁（正常）
            android.util.Log.i("zv-sound", "回到前台：nudge=" + r)
        }
    }

    // ---------- 自动检查更新（用户 2026-09-25："不想再一次次手动下载安装了"）----------

    /** 查一次更新。interactive=true（用户点「检查更新」）时，没新版本也说一句。 */
    fun checkUpdate(interactive: Boolean) {
        Thread {
            var info: Updater.Update? = null
            var err: String? = null
            try {
                info = Updater.check(this, updateBase)
            } catch (e: Exception) {
                err = e.message ?: e.javaClass.simpleName
                android.util.Log.w("zv-update", "检查更新失败：" + err + "（base=" + updateBase + "）")
            }
            runOnUiThread {
                val found = info
                when {
                    found != null && !updatePrompted -> showUpdateDialog(found)
                    found != null -> android.util.Log.i("zv-update", "本进程已提示过，跳过重复弹窗")
                    interactive && err == null -> toast("已是最新版本（" + Updater.appVersion(this) + "）")
                    interactive -> toast("检查更新失败：" + (err ?: "未知原因"))
                    else -> android.util.Log.i("zv-update", "已是最新（" + Updater.appVersion(this) + "）")
                }
            }
        }.start()
    }

    private fun showUpdateDialog(info: Updater.Update) {
        updatePrompted = true
        android.util.Log.i("zv-update", "发现新版本 " + info.version + "（当前 " + Updater.appVersion(this) + "）")
        AlertDialog.Builder(this)
            .setTitle("发现新版本 " + info.version)
            .setMessage("当前 " + Updater.appVersion(this) + "，共 " + (info.size / 1024 / 1024) +
                " MB。点「立即更新」自动下载，下载完在系统界面点一下「安装」即可。")
            .setPositiveButton("立即更新") { _, _ -> startUpdate(info) }
            .setNegativeButton("稍后", null)
            .show()
    }

    private fun startUpdate(info: Updater.Update) {
        if (!Updater.canInstall(this)) {
            android.util.Log.w("zv-update", "缺少「安装未知应用」权限，先引导用户去设置")
            AlertDialog.Builder(this)
                .setTitle("还差一步：允许安装")
                .setMessage("安卓要求你自己允许一次：设置 → 应用 → 特殊应用权限 → 安装未知应用 → zizvideo → 允许。" +
                    "允许之后再点一次「检查更新」，之后就能一键升级了。")
                .setPositiveButton("去设置") { _, _ ->
                    try {
                        startActivity(
                            Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + packageName)))
                    } catch (e: Exception) {
                        toast("打不开设置页，请手动去「安装未知应用」里允许：" + (e.message ?: ""))
                    }
                }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        val progress = android.app.ProgressDialog(this)
        progress.setTitle("正在下载 " + info.version)
        progress.setMessage("0%")
        progress.setCancelable(false)
        progress.show()
        Thread {
            try {
                val file = Updater.download(this, updateBase, info) { pct ->
                    runOnUiThread { progress.setMessage(pct.toString() + "%") }
                }
                runOnUiThread {
                    progress.dismiss()
                    installApk(file)
                }
            } catch (e: Exception) {
                android.util.Log.w("zv-update", "下载失败：" + (e.message ?: ""))
                runOnUiThread {
                    progress.dismiss()
                    AlertDialog.Builder(this)
                        .setTitle("更新失败")
                        .setMessage(e.message ?: "未知原因")
                        .setPositiveButton("知道了", null)
                        .show()
                }
            }
        }.start()
    }

    private fun installApk(apk: java.io.File) {
        try {
            val intent = Updater.install(this, apk)
            startActivity(intent)
            android.util.Log.i("zv-update", "已拉起系统安装器：" + apk.name + "（" + apk.length() + " B）")
        } catch (e: Exception) {
            android.util.Log.w("zv-update", "拉起安装器失败：" + (e.message ?: ""))
            toast("打不开安装界面：" + (e.message ?: "未知原因") + "，安装包在 " + apk.absolutePath)
        }
    }

    private fun toast(text: String) {
        android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_LONG).show()
    }

    override fun onDestroy() {
        mediaFuture?.let { MediaController.releaseFuture(it) }
        // 全屏视频要先收干净，否则会漏一个 SurfaceView
        customView?.let { fullscreen.removeView(it) }
        web.destroy()
        super.onDestroy()
    }

}
