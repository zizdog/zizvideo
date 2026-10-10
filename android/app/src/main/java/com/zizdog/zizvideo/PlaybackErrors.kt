package com.zizdog.zizvideo

import androidx.media3.common.PlaybackException

/**
 * 播放错误 → 人话（纯逻辑，方便单测）。
 *
 * 为什么抽出来：原来这份映射是 PlaybackService 的 private 方法，只有服务自己能用；
 * 于是播放页要显示错误就得把回调塞到服务上（服务静态持有 Activity 回调 = 泄漏，见 PlayerActivity）。
 * 现在服务与播放页都用这一份，播放页自己订阅 `Player.Listener.onPlayerError` 就够了。
 */
object PlaybackErrors {

    /**
     * @param errorCode  PlaybackException.errorCode
     * @param httpCode   底层 HTTP 码（不是 HTTP 错误时传 0）
     * @param errorCodeName 兜底文案里用的错误名（PlaybackException.errorCodeName）
     */
    fun friendly(errorCode: Int, httpCode: Int, errorCodeName: String = ""): String = when (errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        -> "网络断了，连不上服务器"
        // HTTP 码要分细：404 其实是"文件不在了"，笼统说成"登录过期"是错的（实测踩过）
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> when (httpCode) {
            404 -> "文件不在了（可能已改名或移动）"
            401, 403 -> "登录过期了，请重新登录"
            416 -> "这个视频的数据不完整"
            0 -> "服务器拒绝了请求"
            else -> "服务器出错（HTTP " + httpCode + "）"
        }
        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "文件不在了（可能已改名或移动）"
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        -> "这台手机解不了这个视频"
        else -> "播放出错：" + errorCodeName
    }
}
