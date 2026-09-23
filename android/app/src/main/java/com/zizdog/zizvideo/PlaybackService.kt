package com.zizdog.zizvideo

import android.app.PendingIntent
import android.content.Intent
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

    private var session: MediaSession? = null
    private lateinit var player: ExoPlayer
    private val handler = Handler(Looper.getMainLooper())
    // 进度回写必须**离开主线程**：安卓禁止主线程做网络，上一版就是在这儿把 service 崩掉的。
    private val reporter = Executors.newSingleThreadExecutor()
    private var reporting = false
    private var base = ""
    private var cookie = ""

    private val tick = object : Runnable {
        override fun run() {
            report()
            handler.postDelayed(this, 5000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        base = Prefs(this).baseUrl
        cookie = android.webkit.CookieManager.getInstance().getCookie(base) ?: ""
        val headers = if (cookie.isBlank()) emptyMap() else mapOf("Cookie" to cookie)
        val factory = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(headers)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(20000)
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

    /**
     * 进度回写：只在有进度时发，失败静默（5 秒后再报）。
     * player 的读数必须在主线程取，网络必须在后台线程发 —— 两边分开，别再混在一起。
     */
    private fun report() {
        val item = player.currentMediaItem ?: return
        val id = item.mediaId
        if (id.isBlank() || cookie.isBlank()) return
        val pos = player.currentPosition
        val dur = player.duration
        if (pos <= 0) return
        val done = dur > 0 && pos >= dur - 1000
        val total = if (dur > 0) dur else 0L
        if (reporting) return
        reporting = true
        reporter.execute {
            try {
                ZvApi2.reportProgress(base, cookie, id, pos, total, done)
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
