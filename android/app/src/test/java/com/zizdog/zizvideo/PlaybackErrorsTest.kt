package com.zizdog.zizvideo

import androidx.media3.common.PlaybackException
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 播放错误 → 人话（P1 的一部分）。
 *
 * 为什么要有这个门禁：播放页原来靠 `PlaybackService.onError`（服务静态持有 Activity 的回调）
 * 才能显示错误；现在改成播放页自己订阅 `Player.Listener.onPlayerError`，两边必须用**同一份**文案，
 * 所以文案本体抽成纯函数并在单测里钉住。修之前这个映射是 service 的 private 方法，测不到。
 */
class PlaybackErrorsTest {

    @Test
    fun networkAndHttpErrorsSayWhatHappened() {
        assertEquals(
            "网络断了，连不上服务器",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, 0),
        )
        assertEquals(
            "网络断了，连不上服务器",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT, 0),
        )
        // HTTP 码要分细：404 是"文件不在了"，说成"登录过期"是错的（实测踩过）
        assertEquals(
            "文件不在了（可能已改名或移动）",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 404),
        )
        assertEquals(
            "登录过期了，请重新登录",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 401),
        )
        assertEquals(
            "登录过期了，请重新登录",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 403),
        )
        assertEquals(
            "这个视频的数据不完整",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 416),
        )
        assertEquals(
            "服务器拒绝了请求",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 0),
        )
        assertEquals(
            "服务器出错（HTTP 500）",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 500),
        )
    }

    @Test
    fun localErrorsSayWhatHappened() {
        assertEquals(
            "文件不在了（可能已改名或移动）",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND, 0),
        )
        assertEquals(
            "这台手机解不了这个视频",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, 0),
        )
        assertEquals(
            "这台手机解不了这个视频",
            PlaybackErrors.friendly(PlaybackException.ERROR_CODE_DECODING_FAILED, 0),
        )
    }

    /** 没认出来的错误也得说点什么（带错误名，方便用户念给我听）。 */
    @Test
    fun unknownErrorStillSaysSomething() {
        assertEquals("播放出错：ERROR_CODE_UNSPECIFIED", PlaybackErrors.friendly(1000, 0, "ERROR_CODE_UNSPECIFIED"))
        assertEquals("播放出错：", PlaybackErrors.friendly(-1, 0))
    }
}
