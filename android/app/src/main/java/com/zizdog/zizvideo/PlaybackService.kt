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

    companion object {
        /** MediaMetadata.extras 里带这一条的播放音量（0..1，音量均一化的结果）。 */
        const val EXTRA_VOLUME = "gain_volume"
        /** 兼容：早先只带 dB 增益时的键（现在统一成 EXTRA_VOLUME）。 */
        const val EXTRA_GAIN_DB = "gain_db"

        /**
         * 单进程内的服务实例：WebActivity 的"退后台交接"直接用它。
         * **不要覆盖 onBind**：MediaSessionService 靠 onBind 把 MediaController 连接给播放页，
         * 覆盖它就等于把播放页的控制器掐断 —— 表现是黑屏+没标题+按钮不上色（实测踩过这个坑）。
         */
        @Volatile
        var instance: PlaybackService? = null
            private set

        /**
         * 播放错误 → 人话。服务与播放页共用这一份（映射本体是纯函数 PlaybackErrors，可单测）。
         * HTTP 码不在 PlaybackException 上，得从 cause 里取（media3 1.4 的 API 就是这样）。
         */
        fun friendlyErrorMessage(error: androidx.media3.common.PlaybackException): String {
            val http =
                (error.cause as? androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)?.responseCode ?: 0
            return PlaybackErrors.friendly(error.errorCode, http, error.errorCodeName)
        }
    }

    /** 当前在播的媒体 id 与位置（回前台时用来把播放收回网页）。 */
    fun current(): Pair<String, Long>? {
        val item = player.currentMediaItem ?: return null
        return item.mediaId to player.currentPosition
    }

    fun stopPlayback() {
        player.stop()
        player.clearMediaItems()
    }

    private var session: MediaSession? = null

    /** 最近一次播放错误（人话）；播放页进来时先读它，避免错过已发生的错误。 */
    @Volatile
    var lastError: String? = null
        private set

    private fun friendlyError(error: androidx.media3.common.PlaybackException): String =
        friendlyErrorMessage(error)
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
        instance = this
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
            // 手机上切网/信号差很常见：默认可重试次数太少，给 5 次（media3 里这个策略挂在数据源工厂上）
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(factory).setLoadErrorHandlingPolicy(
                    androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy(5),
                ),
            )
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
                applyGain(item) // 每条的音量可能不同（均一化）
                report()
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                // 别静默：界面要能说"放不了/网络断了"，否则用户只看到黑屏卡住（坑）。
                // ⚠️ **不往 Activity 塞回调**：播放页自己订阅 MediaController 的 onPlayerError
                //    （media3 会把 playerError 转给控制器监听器），服务里只留最近一条文本。
                lastError = friendlyError(error)
            }

            override fun onPlayerErrorChanged(error: androidx.media3.common.PlaybackException?) {
                if (error == null) lastError = null
            }
        })
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, PlayerActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // 系统通知/锁屏/状态栏里的封面：媒体库自己会去拉 MediaMetadata.artworkUri，
        // 但封面接口要会话 cookie ⇒ 给它一个**带 cookie 的数据源**（用同一份 header 注入逻辑）。
        // 没有这一句，通知里就只有文字、没有抖音那种封面/预览（用户 2026-09-25 报障）。
        val artExecutor = com.google.common.util.concurrent.MoreExecutors.listeningDecorator(
            java.util.concurrent.Executors.newSingleThreadExecutor(),
        )
        val artLoader = androidx.media3.session.CacheBitmapLoader(
            androidx.media3.datasource.DataSourceBitmapLoader(artExecutor, factory),
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(openApp)
            .setBitmapLoader(artLoader)
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** 已经预热过的队列指纹（ids+index）：重复 prepare 不重置缓冲，交接才能"无缝"。 */
    private var preparedKey = ""

    /** 预热带到哪个位置了（网页每隔一会儿报一次进度，见 prepareItems）。 */
    private var warmPositionMs = 0L

    /**
     * 预热：只把队列准备好 + prepare()（不播）。网页一开播就调它 ⇒ 退后台交接时不用现拉流，
     * 不会"卡一下"（用户 2026-09-23 报障）。
     *
     * positionMs（用户 2026-09-25 新增）：网页播放中会隔一会儿报一次**当前进度**，同一条时
     * 只把预热位置往前挪（一次 seek，不用重建队列）—— 退后台交接时就不用从很旧的位置重新缓冲，
     * 这才是"退到桌面卡一下 / 声音回退一两秒"的根子。
     */
    fun prepareItems(ids: List<String>, titles: List<String>, index: Int, positionMs: Long = 0L,
                     volumes: List<Float> = emptyList()) {
        if (ids.isEmpty()) return
        val key = ids.joinToString(",") + "#" + index
        base = Prefs(this).baseUrl
        if (key == preparedKey) {
            // 同一条：只挪预热位置。只在"确实往前走了"时动，避免每几秒来一次无意义的 seek。
            if (positionMs > warmPositionMs + 2000) {
                warmPositionMs = positionMs
                val start = index.coerceIn(0, ids.size - 1)
                handler.post {
                    if (player.mediaItemCount > start && !player.isPlaying) {
                        player.seekTo(start, positionMs)
                    }
                }
            }
            return
        }
        preparedKey = key
        warmPositionMs = positionMs
        val items = buildItems(ids, titles, volumes)
        val start = index.coerceIn(0, items.size - 1)
        handler.post {
            player.setMediaItems(items, start, positionMs.coerceAtLeast(0L))
            player.prepare()
            player.pause()
        }
    }

    /**
     * 音量均一化（用户 2026-09-26）：把这一条的增益（dB ≤ 0）落到 ExoPlayer 的音量上。
     * 增益来自服务端量的响度（目标 -16 LUFS，只衰减不放大），放在 MediaMetadata.extras 里带过来。
     */
    /** 服务端给的 gain_db（≤0）→ 播放音量（0..1）。 */
    private fun gainVolume(gainDb: Double): Float =
        if (gainDb < 0) Math.pow(10.0, gainDb / 20.0).toFloat().coerceIn(0f, 1f) else 1f

    private fun applyGain(item: MediaItem?) {
        val ex = item?.mediaMetadata?.extras
        // 优先用"网页交接时给的 volume"（网页已经按 gain_db 设过它的 video.volume，是同一份判据）；
        // 没有就退回 gain_db 现算。都没有 = 1（不调）。
        val v = when {
            ex != null && ex.containsKey(EXTRA_VOLUME) -> ex.getFloat(EXTRA_VOLUME, 1f)
            ex != null && ex.containsKey(EXTRA_GAIN_DB) -> {
                val g = ex.getDouble(EXTRA_GAIN_DB, 0.0)
                if (g < 0) Math.pow(10.0, g / 20.0).toFloat() else 1f
            }
            else -> 1f
        }.coerceIn(0f, 1f)
        player.volume = v
        // 落日志：模拟器没有声音输出，"音量到底设没设"只能靠这条看（用户 2026-09-26）
        android.util.Log.i("zv-gain", "volume=" + v + " item=" + (item?.mediaId ?: "-"))
    }

    private fun buildItems(ids: List<String>, titles: List<String>,
                           volumes: List<Float> = emptyList()) = ids.mapIndexed { i, id ->
        // ④ 有离线缓存就放本地文件：断网/服务器不在也能接着看（后台连播同样走这里）
        val local = OfflineStore.localUri(this, id)
        MediaItem.Builder()
            .setUri(local ?: "$base/api/v1/media/" + android.net.Uri.encode(id) + "/stream")
            .setMediaId(id)
            .setMediaMetadata(
                androidx.media3.common.MediaMetadata.Builder()
                    .setTitle(titles.getOrNull(i)?.ifBlank { id } ?: id)
                    // 封面：系统媒体通知/锁屏/状态栏里那个大图（用户 2026-09-25："状态栏播放没有图标，
                    // 抖音/bilibili 都有封面"）。封面接口要会话 cookie ⇒ MediaSession 配了带 cookie 的
                    // DataSourceBitmapLoader（见 onCreate）。
                    .setArtworkUri(android.net.Uri.parse(
                        "$base/api/v1/media/" + android.net.Uri.encode(id) + "/cover"))
                    .setExtras(android.os.Bundle().apply {
                        putFloat(EXTRA_VOLUME, volumes.getOrNull(i) ?: 1f)
                    })
                    .build(),
            )
            .build()
    }

    /** 按给定 id 列表播（stream 地址由 base 拼），从 index 条的 positionMs 开始。 */
    fun playItems(ids: List<String>, titles: List<String>, index: Int, positionMs: Long,
                  volumes: List<Float> = emptyList()) {
        if (ids.isEmpty()) return
        base = Prefs(this).baseUrl // 同上：换服务器后 stream 地址也要跟着走
        val key = ids.joinToString(",") + "#" + index.coerceIn(0, ids.size - 1)
        val warm = key == preparedKey
        val items = buildItems(ids, titles, volumes)
        val start = index.coerceIn(0, items.size - 1)
        // 交接日志：定位"退到桌面卡一下 / 声音回退一两秒"必须看得见两边的时间点
        android.util.Log.i("zv-handoff", "playItems warm=$warm index=$start pos=$positionMs key=" +
            key.take(24) + "… items=${items.size} warmPos=$warmPositionMs")
        handler.post {
            if (warm && player.mediaItemCount == items.size) {
                // 已经预热过同一条：只对齐位置就播，省掉重新拉流那一下（"卡一下"就是这个）
                player.seekTo(start, if (positionMs > 0) positionMs else 0L)
            } else {
                player.setMediaItems(items, start, if (positionMs > 0) positionMs else 0L)
                player.prepare()
            }
            preparedKey = key
            warmPositionMs = positionMs
            applyGain(player.currentMediaItem)
            player.play()
            // 起来之后回报一次真实位置：和交接前的网页位置一比，就知道有没有回退/空档
            handler.postDelayed({
                android.util.Log.i("zv-handoff", "native started at " + player.currentPosition +
                    "ms（交接时给的是 " + positionMs + "ms）")
            }, 1200)
        }
    }

    /** 拉一份队列并开始播（网页交接过来的那一条 + 它的位置）。网线活儿全在后台线程。 */
    fun playQueue(kind: String, mediaId: String, positionMs: Long) {
        // 每次现读：用户可能换了服务器（原来只在为空时读，换服务器后会往老地址拉）
        base = Prefs(this).baseUrl
        val c = cookie()
        Thread {
            // mediaId 显式传进去：`single` 那种队列的 id 只从这儿来（坑 65 —— 只看 query 会拉出空队列）
            val list = ZvApi2.queue(base, kind, c, "", mediaId)
            if (list.isEmpty()) return@Thread
            val items = list.map { m ->
                val local = OfflineStore.localUri(this, m.id)
                if (local != null) android.util.Log.i("zv-offline", "play local id=" + m.id)
                MediaItem.Builder()
                    .setUri(local ?: m.streamUrl)
                    .setMediaId(m.id)
                    .setMediaMetadata(
                        androidx.media3.common.MediaMetadata.Builder()
                            .setTitle(m.title)
                            .setArtworkUri(android.net.Uri.parse(
                                "$base/api/v1/media/" + android.net.Uri.encode(m.id) + "/cover"))
                            .setExtras(android.os.Bundle().apply {
                                putFloat(EXTRA_VOLUME, gainVolume(m.gainDb))
                            })
                            .build(),
                    )
                    .build()
            }
            val index = list.indexOfFirst { it.id == mediaId }.coerceAtLeast(0)
            handler.post {
                player.setMediaItems(items, index, if (positionMs > 0) positionMs else 0L)
                player.prepare()
                applyGain(player.currentMediaItem)
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
        instance = null
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
