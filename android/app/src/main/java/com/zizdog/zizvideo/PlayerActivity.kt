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
            c.addListener(object : androidx.media3.common.Player.Listener {
                override fun onMediaMetadataChanged(metadata: MediaMetadata) = paint(metadata.title?.toString() ?: "")
                override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                    paint(item?.mediaMetadata?.title?.toString() ?: "")
                    refreshState(item?.mediaId ?: "")
                }
            })
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
            val list = try {
                ZvApi2.queue(base, kind, cookie, query)
            } catch (e: Exception) {
                Log.e("zvplayer", "拉队列失败 kind=$kind base=$base", e)
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
                    nowPlaying.text = "这条没有可播的内容"
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
