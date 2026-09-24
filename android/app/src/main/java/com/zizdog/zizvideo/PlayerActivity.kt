package com.zizdog.zizvideo

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.CookieManager
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.media3.ui.PlayerView
import com.google.android.material.button.MaterialButton
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors

/**
 * 原生播放页：点网页里「收藏/历史/稍后再看」的卡片（深链 #/play/<kind>/<id>）时由 WebActivity 截住并起这里。
 * 队列由原生自己用 API 拉（不依赖网页状态），交给 PlaybackService 的 ExoPlayer 播 ⇒ 后台/锁屏都稳。
 * 退出这个页面**不停播放**：那是"听视频"的预期；要停就点「停止并退出」。
 */
class PlayerActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_KIND = "kind"
        const val EXTRA_MEDIA_ID = "media_id"

        /** search 队列要关键词（网页那边是临时缓存，原生拿地址里的词自己重放同一份结果）。 */
        const val EXTRA_QUERY = "query"
    }

    private lateinit var view: PlayerView
    private lateinit var nowPlaying: TextView
    private lateinit var favBtn: android.widget.ImageButton
    private lateinit var likeBtn: android.widget.ImageButton
    private lateinit var laterBtn: android.widget.ImageButton
    private var currentId = ""
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var resumed = false // 本条是从上次位置接着放的（标题上要标出来，与网页端同义）

    // B5：倍速 / 长按快进 / 双击点赞（与网页同一套语义，倍速设置也共用服务端那份）
    private lateinit var speedBtn: MaterialButton
    private lateinit var likeBurst: android.widget.ImageView
    private lateinit var ffHint: android.widget.TextView
    private var speed = 1.0f
    private var likedNow = false
    private var ffTimer: Runnable? = null
    private val ffHandler = android.os.Handler(android.os.Looper.getMainLooper())
    // 双击前的播放状态：控件条的点击可能顺手把播放/暂停翻了，双击达成时要还原（不然"点个赞把片子点了暂停"）
    private var preTapPlaying = false
    private var tapWindow = false
    // 双击后要还原的播放状态（null=不用还原）：控件条把两次点击各翻了一次播放/暂停，
    // 必须在**第二次抬手之后**还原，不然还原又被第二次点击翻回去（实测：双击会变成暂停）
    private var restorePlaying: Boolean? = null


    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 拒了也能放，只是没有通知 */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        Ui.padSystemBars(findViewById(R.id.playerRoot))
        view = findViewById(R.id.player)
        nowPlaying = findViewById(R.id.nowPlaying)
        favBtn = findViewById(R.id.fav)
        likeBtn = findViewById(R.id.like)
        laterBtn = findViewById(R.id.later)
        favBtn.setOnClickListener { toggle("fav") }
        likeBtn.setOnClickListener { toggle("like") }
        laterBtn.setOnClickListener { toggle("later") }
        // B4 画中画：把播放页缩成浮窗（原生播放器继续放，退出页面也不停）
        findViewById<android.widget.ImageButton>(R.id.pip).setOnClickListener { enterPip() }
        // B5 倍速：点一下换一档（0.5→0.75→1→1.25→1.5→2→0.5…），并写回服务端
        speedBtn = findViewById(R.id.speed)
        likeBurst = findViewById(R.id.likeBurst)
        ffHint = findViewById(R.id.ffHint)
        speedBtn.setOnClickListener { cycleSpeed() }
        setupGestures()
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        val kind = intent.getStringExtra(EXTRA_KIND) ?: ""
        val mediaId = intent.getStringExtra(EXTRA_MEDIA_ID) ?: ""
        val query = intent.getStringExtra(EXTRA_QUERY) ?: ""
        val base = Prefs(this).baseUrl
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            // 连接失败要**说出来**：不然就是"黑屏 + 没标题 + 按钮不上色"这种静默失败（实测踩过）
            val c = try {
                future.get()
            } catch (e: Exception) {
                Log.e("zvplayer", "controller 连接失败", e)
                nowPlaying.text = "播放器没连上，退出去重进一次"
                return@addListener
            }
            controller = c
            view.player = c
            PlaybackService.instance?.let { svc ->
                svc.onError = { msg -> runOnUiThread { nowPlaying.text = msg } }
                svc.lastError?.let { nowPlaying.text = it } // 进页面前就错了的，也别漏
            }
            c.addListener(object : androidx.media3.common.Player.Listener {
                override fun onMediaMetadataChanged(metadata: MediaMetadata) = paint(metadata.title?.toString() ?: "")
                override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                    paint(item?.mediaMetadata?.title?.toString() ?: "")
                    refreshState(item?.mediaId ?: "")
                }
            })
            refreshState(c.currentMediaItem?.mediaId ?: "") // 监听器挂上前就设好的条目也要对齐
            loadSpeed() // 服务端存着的倍速（网页改过也跟着）
            c.setPlaybackSpeed(speed)
            if (kind == "feed") {
                loadQueue(base, kind, "", c, query)     // 首页队列：没有"起点"，从头播
            } else if (kind.isNotEmpty() && mediaId.isNotEmpty()) {
                loadQueue(base, kind, mediaId, c, query)
            } else {
                paint(c.currentMediaItem?.mediaMetadata?.title?.toString() ?: "正在播放")
            }
        }, MoreExecutors.directExecutor())

        findViewById<MaterialButton>(R.id.stop).setOnClickListener {
            controller?.stop()
            stopService(Intent(this, PlaybackService::class.java))
            finish()
        }
    }

    // ---------- B5 倍速 / 长按快进 / 双击点赞 ----------

    private val speeds = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)

    private fun trimNum(v: Float): String =
        if (Math.abs(v - Math.round(v)) < 0.01f) Math.round(v).toString()
        else String.format(java.util.Locale.US, "%.2f", v).trimEnd('0').trimEnd('.')

    private fun speedLabel(v: Float): String =
        if (Math.abs(v - 1f) < 0.01f) "1×" else trimNum(v) + "×"

    private fun applySpeed(v: Float, persist: Boolean) {
        speed = v
        controller?.setPlaybackSpeed(v)
        speedBtn.text = speedLabel(v)
        Log.i("zv-speed", "rate=" + trimNum(v))
        if (!persist) return
        Thread {
            val b = base()
            val c = android.webkit.CookieManager.getInstance().getCookie(b) ?: return@Thread
            ZvApi2.setPlaybackRate(b, c, v.toDouble())
        }.start()
    }

    /** 进页面就读服务端的倍速（网页里改过，手机上跟着变）。 */
    private fun loadSpeed() {
        Thread {
            val b = base()
            val c = android.webkit.CookieManager.getInstance().getCookie(b) ?: return@Thread
            val v = ZvApi2.playbackRate(b, c).toFloat()
            runOnUiThread { if (v > 0.01f) applySpeed(v, false) }
        }.start()
    }

    private fun cycleSpeed() {
        val idx = speeds.indexOfFirst { Math.abs(it - speed) < 0.01f }
        val next = speeds[(if (idx < 0) 2 else idx + 1) % speeds.size]
        applySpeed(next, true)
    }

    /**
     * 手势：按住画面 350ms ⇒ 2× 快进（松手回到设置的倍速）；双击 ⇒ 点赞/取消点赞。
     * 监听器只**观察**触摸（返回 false），PlayerView 自己的控件/拖动条照常工作。
     */
    private fun setupGestures() {
        val detector = android.view.GestureDetector(this,
            object : android.view.GestureDetector.SimpleOnGestureListener() {
                override fun onDoubleTap(e: android.view.MotionEvent): Boolean {
                    // 双击是"点赞手势"，不该顺带暂停：把双击前的播放状态记下来，等手势结束再还原
                    val c = controller
                    if (c != null && c.isPlaying != preTapPlaying) restorePlaying = preTapPlaying
                    doubleTapLike()
                    return true
                }
            })
        // 观察层换成 GesturePlayerView.dispatchTouchEvent（见该类注释：控件条会吃掉触摸）
        val gestureView = view as? GesturePlayerView
        gestureView?.onGesture = { event ->
            if (event.actionMasked == android.view.MotionEvent.ACTION_DOWN) {
                Log.i("zv-touch", "down " + event.x.toInt() + "," + event.y.toInt())
            }
            detector.onTouchEvent(event)
            when (event.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    if (!tapWindow) {
                        preTapPlaying = controller?.isPlaying ?: false
                        tapWindow = true
                        ffHandler.postDelayed({ tapWindow = false }, 320)
                    }
                    val r = Runnable {
                        val c = controller ?: return@Runnable
                        if (c.isPlaying) {
                            c.setPlaybackSpeed(2f)
                            ffHint.visibility = android.view.View.VISIBLE
                            Log.i("zv-speed", "ff=on")
                        }
                    }
                    ffTimer = r
                    ffHandler.postDelayed(r, 350)
                }
                android.view.MotionEvent.ACTION_UP,
                android.view.MotionEvent.ACTION_CANCEL -> {
                    ffTimer?.let { ffHandler.removeCallbacks(it) }
                    ffTimer = null
                    if (ffHint.visibility == android.view.View.VISIBLE) {
                        ffHint.visibility = android.view.View.GONE
                        controller?.setPlaybackSpeed(speed)
                        Log.i("zv-speed", "ff=off rate=" + trimNum(speed))
                    }
                    // 双击的手势结束后再还原播放状态（控件条在这两次点击里各翻了一次）
                    val want = restorePlaying
                    if (want != null) {
                        restorePlaying = null
                        ffHandler.postDelayed({
                            val c = controller
                            if (c != null && c.isPlaying != want) {
                                if (want) c.play() else c.pause()
                                Log.i("zv-like", "restore playing=" + want)
                            }
                        }, 180)
                    }
                }
            }
        }
    }

    /** 双击 = 点赞开关（用户 2026-09-24：双击也能取消）。写接口与图标按钮是同一条。 */
    private fun doubleTapLike() {
        val id = currentId
        Log.i("zv-like", "double-tap id=" + (if (id.isBlank()) "(空)" else id))
        if (id.isBlank()) return
        val willLike = !likedNow
        burstLike(willLike)
        Thread {
            val b = base()
            val c = android.webkit.CookieManager.getInstance().getCookie(b) ?: return@Thread
            if (!ZvApi2.toggleLike(b, c, id, willLike)) return@Thread
            val after = ZvApi2.state(b, c, id) ?: return@Thread
            Log.i("zv-like", "like=" + after.liked)
            runOnUiThread {
                paintState(after, id)
                android.widget.Toast.makeText(this,
                    if (after.liked) "已喜欢" else "已取消喜欢", android.widget.Toast.LENGTH_SHORT).show()
            }
        }.start()
    }

    /** 中央大拇指动画：点赞是亮的，取消是灰的（与网页 .like-burst / .like-burst.off 同义）。 */
    private fun burstLike(on: Boolean) {
        likeBurst.setColorFilter(if (on) 0xFFFFFFFF.toInt() else 0xFFB9BEC6.toInt())
        likeBurst.alpha = 0f
        likeBurst.scaleX = 0.5f
        likeBurst.scaleY = 0.5f
        likeBurst.animate().cancel()
        likeBurst.animate().alpha(1f).scaleX(1.15f).scaleY(1.15f).setDuration(140)
            .withEndAction {
                likeBurst.animate().alpha(0f).scaleX(1.4f).scaleY(1.4f).setDuration(320).start()
            }.start()
    }

    /** B4：进小窗后把互动栏/标题/按钮都收起来 —— 小窗里只该有画面。 */
    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        val vis = if (isInPictureInPictureMode) android.view.View.GONE else android.view.View.VISIBLE
        findViewById<android.view.View>(R.id.chrome).visibility = vis
        nowPlaying.visibility = vis
    }

    /** B4：进小窗。宽高比按当前播放页算；安卓 8 以下没有这个能力，如实说一句。 */
    private fun enterPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            android.widget.Toast.makeText(this, "这台机器（安卓 8 以下）不支持画中画",
                android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val root = findViewById<android.view.View>(R.id.playerRoot)
            val w = root.width.takeIf { it > 0 } ?: 16
            val h = root.height.takeIf { it > 0 } ?: 9
            val params = android.app.PictureInPictureParams.Builder()
                .setAspectRatio(android.util.Rational(w, h))
                .build()
            enterPictureInPictureMode(params)
        } catch (e: Exception) {
            android.widget.Toast.makeText(this, "开不了画中画：" + e.message,
                android.widget.Toast.LENGTH_LONG).show()
        }
    }

    // 标题后缀写在 paint 里：否则会被随后的 metadata/transition 事件刷掉（实测踩过）。
    private fun base(): String = Prefs(this).baseUrl

    /** 三个图标按钮的开关：读当前状态 → 写 → 回读刷新（与网页图标栏同一批接口）。 */
    private fun toggle(kind: String) {
        val id = currentId
        if (id.isBlank()) return
        Thread {
            val b = base()
            val c = android.webkit.CookieManager.getInstance().getCookie(b) ?: return@Thread
            val now = ZvApi2.state(b, c, id) ?: return@Thread
            val ok = when (kind) {
                "fav" -> ZvApi2.toggleFavorite(b, c, id, !now.favorite)
                "like" -> ZvApi2.toggleLike(b, c, id, !now.liked)
                else -> ZvApi2.toggleLater(b, c, id, !now.watchLater)
            }
            if (!ok) return@Thread
            val after = ZvApi2.state(b, c, id) ?: return@Thread
            runOnUiThread { paintState(after, id) }
        }.start()
    }

    private fun refreshState(id: String) {
        currentId = id
        if (id.isBlank()) return
        Thread {
            val b = base()
            val c = android.webkit.CookieManager.getInstance().getCookie(b) ?: return@Thread
            val st = ZvApi2.state(b, c, id) ?: return@Thread
            runOnUiThread { paintState(st, id) }
        }.start()
    }

    private fun paintState(st: ZvApi2.State, id: String) {
        if (id != currentId) return // 期间切集了，丢弃过期状态
        val on = androidx.core.content.ContextCompat.getColor(this, R.color.zv_accent)
        val off = androidx.core.content.ContextCompat.getColor(this, android.R.color.white)
        favBtn.setColorFilter(if (st.favorite) on else off)
        likedNow = st.liked
        likeBtn.setColorFilter(if (st.liked) on else off)
        laterBtn.setColorFilter(if (st.watchLater) on else off)
    }

    private fun paint(title: String) {
        val base = if (title.isBlank()) "正在播放" else "正在播放：$title"
        nowPlaying.text = if (resumed) "$base（已续播）" else base
    }

    /** 拉列表 → 转成 ExoPlayer 的队列 → 从点中的那一条开始播。 */
    private fun loadQueue(base: String, kind: String, mediaId: String, c: MediaController, query: String = "") {
        val cookie = CookieManager.getInstance().getCookie(base) ?: ""
        Thread {
            var fetched = true
            val list = try {
                ZvApi2.queue(base, kind, cookie, query)
            } catch (e: Exception) {
                Log.e("zvplayer", "拉队列失败 kind=$kind base=$base", e)
                fetched = false
                emptyList()
            }
            Log.i("zvplayer", "queue kind=$kind id=$mediaId 条数=" + list.size)
            val items = list.map { m ->
                MediaItem.Builder()
                    .setUri(m.streamUrl)
                    .setMediaId(m.id)
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(m.title).build())
                    .build()
            }
            val index = list.indexOfFirst { it.id == mediaId }.coerceAtLeast(0)
            val resume = list.getOrNull(index)?.resumeMs ?: 0L
            runOnUiThread {
                if (items.isEmpty()) {
                    // 如实区分"没内容"和"连不上"：说错原因比不说更糟（原来一律说"没有可播的内容"）
                    nowPlaying.text = if (fetched) "这条没有可播的内容" else "连不上服务器，拉不到播放列表"
                    return@runOnUiThread
                }
                refreshState(items.getOrNull(index)?.mediaId ?: "")
                resumed = resume > 0
                c.setMediaItems(items, index, resume) // 续播位置与网页端同语义（没看完才续）
                c.prepare()
                c.play()
                paint(list.getOrNull(index)?.title ?: "")
            }
        }.start()
    }

    override fun onDestroy() {
        // 只放掉控制器，**不**停服务：退到后台/锁屏继续放。
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controller = null
        super.onDestroy()
    }
}
