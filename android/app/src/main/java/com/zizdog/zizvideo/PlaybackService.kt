package com.zizdog.zizvideo

import android.app.PendingIntent
import android.content.Intent
import android.os.Binder
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * 后台"听视频"的核心（用户 2026-09-23：要稳定后台运行）：MediaSessionService + 前台服务。
 *   · ExoPlayer 默认走 MediaCodec ⇒ 硬件解码；这里显式设音频属性以接管音频焦点（别人出声会避让）；
 *   · 数据源显式带上会话 cookie —— 播放器的 HTTP 栈跟 WebView 的 cookie 罐**不共享**，不带就 401；
 *   · MediaSession 白送通知栏/锁屏控制与耳机按键；
 *   · 进度按网页端同一个 PATCH /me/progress 回写（原生侧自己上报，因为页面可能已被冻结）。
 */
class PlaybackService : MediaSessionService() {

    /**
     * 给同进程的 WebActivity 用：网页退到后台时把播放"交接"过来（Chromium 会挂起隐藏页面的媒体，
     * 而浏览器的 Chrome 之所以能后台放，是因为它替页面建了 MediaSession + 前台服务 —— WebView 没有）。
     * 走**绑定**而不是 startService：后台限制针对的是 startForegroundService/startService，
     * 绑定不受限；前台服务提升由本服务在做完准备后自己调。
     */
    inner class LocalBinder : Binder() {
        fun playQueue(kind: String, mediaId: String, positionMs: Long) = this@PlaybackService.playQueue(kind, mediaId, positionMs)

        /** 网页交接：按**网页自己那份队列**（顺序、标题都由它给）接着播，别去重新拉一页（顺序会对不上）。 */
        fun playItems(ids: List<String>, titles: List<String>, index: Int, positionMs: Long) =
            this@PlaybackService.playItems(ids, titles, index, positionMs)
        fun current(): Pair<String, Long>? {
            val item = player.currentMediaItem ?: return null
            return item.mediaId to player.currentPosition
        }
        fun stopPlayback() {
            player.stop()
            player.clearMediaItems()
        }
    }

    private val binder = LocalBinder()

    override fun onBind(intent: Intent?): android.os.IBinder = binder

    private var session: MediaSession? = null
    private lateinit var player: ExoPlayer
    private val handler = Handler(Looper.getMainLooper())
    // 进度回写必须**离开主线程**：安卓禁止主线程做网络，上一版就是在这儿把 service 崩掉的。
    private val reporter = Executors.newSingleThreadExecutor()
    private var reporting = false
    private var base = ""

    /** 会话 cookie 现读：服务只在 onCreate 缓存它的话，用户在网页里重新登录后就一直 401（修过）。 */
    private fun cookie(): String =
        android.webkit.CookieManager.getInstance().getCookie(base) ?: ""

    private val tick = object : Runnable {
        override fun run() {
            report()
            handler.postDelayed(this, 5000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        base = Prefs(this).baseUrl
        // 数据源工厂在**每次建流时**现读 cookie（登录/换服务器后不用重启服务）
        val factory = object : androidx.media3.datasource.DataSource.Factory {
            override fun createDataSource(): androidx.media3.datasource.DataSource {
                val c = cookie()
                val headers = if (c.isBlank()) emptyMap() else mapOf("Cookie" to c)
                return DefaultHttpDataSource.Factory()
                    .setDefaultRequestProperties(headers)
                    .setConnectTimeoutMs(15000)
                    .setReadTimeoutMs(20000)
                    .createDataSource()
            }
        }
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(factory))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setWakeMode(C.WAKE_MODE_NETWORK) // 后台/锁屏继续放
            .setHandleAudioBecomingNoisy(true) // 拔耳机就停，别外放
            .build()
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) {
                    handler.removeCallbacks(tick)
                    handler.postDelayed(tick, 5000)
                }
            }

            override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                report()
            }
        })
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, PlayerActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        session = MediaSession.Builder(this, player).setSessionActivity(openApp).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** 按给定 id 列表播（stream 地址由 base 拼），从 index 条的 positionMs 开始。 */
    fun playItems(ids: List<String>, titles: List<String>, index: Int, positionMs: Long) {
        if (ids.isEmpty()) return
        val items = ids.mapIndexed { i, id ->
            MediaItem.Builder()
                .setUri("$base/api/v1/media/" + android.net.Uri.encode(id) + "/stream")
                .setMediaId(id)
                .setMediaMetadata(
                    androidx.media3.common.MediaMetadata.Builder()
                        .setTitle(titles.getOrNull(i)?.ifBlank { id } ?: id)
                        .build(),
                )
                .build()
        }
        val start = index.coerceIn(0, items.size - 1)
        handler.post {
            player.setMediaItems(items, start, if (positionMs > 0) positionMs else 0L)
            player.prepare()
            player.play()
        }
    }

    /** 拉一份队列并开始播（网页交接过来的那一条 + 它的位置）。网线活儿全在后台线程。 */
    fun playQueue(kind: String, mediaId: String, positionMs: Long) {
        if (base.isBlank()) base = Prefs(this).baseUrl
        val c = cookie()
        Thread {
            val list = ZvApi2.queue(base, kind, c)
            if (list.isEmpty()) return@Thread
            val items = list.map { m ->
                MediaItem.Builder()
                    .setUri(m.streamUrl)
                    .setMediaId(m.id)
                    .setMediaMetadata(androidx.media3.common.MediaMetadata.Builder().setTitle(m.title).build())
                    .build()
            }
            val index = list.indexOfFirst { it.id == mediaId }.coerceAtLeast(0)
            handler.post {
                player.setMediaItems(items, index, if (positionMs > 0) positionMs else 0L)
                player.prepare()
                player.play()
            }
        }.start()
    }

    /**
     * 进度回写：只在有进度时发，失败静默（5 秒后再报）。
     * player 的读数必须在主线程取，网络必须在后台线程发 —— 两边分开，别再混在一起。
     */
    private fun report() {
        val item = player.currentMediaItem ?: return
        val id = item.mediaId
        val c = cookie()
        if (id.isBlank() || c.isBlank()) return
        val pos = player.currentPosition
        val dur = player.duration
        if (pos <= 0) return
        val done = dur > 0 && pos >= dur - 1000
        val total = if (dur > 0) dur else 0L
        if (reporting) return
        reporting = true
        reporter.execute {
            try {
                ZvApi2.reportProgress(base, c, id, pos, total, done)
            } catch (e: Exception) {
                // 报进度失败不影响听视频，下次再报
            } finally {
                reporting = false
            }
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 用户把 App 从最近任务划掉：没在播就收工，在播就继续（"听视频"的预期）
        if (player.playWhenReady && player.mediaItemCount > 0) return
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        reporter.shutdownNow()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}
