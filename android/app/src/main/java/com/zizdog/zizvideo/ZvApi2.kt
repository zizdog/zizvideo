package com.zizdog.zizvideo

import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * 原生播放要用的第二块 API：把网页端那套列表/进度接口原样用起来（不另立一套契约）。
 * 关键点：**播放器的 HTTP 请求不会自动带 WebView 的 cookie**（ExoPlayer 用自己的 http 栈），
 * 所以流地址的 Cookie 头必须由这里显式提供；写操作还要回填 X-CSRF-Token（同网页端的双提交）。
 */
object ZvApi2 {

    /**
     * 播放队列的来源。前四种与网页 #/play/<kind>/<id> 一一对应；
     * search 需要关键词（网页那边是临时缓存，原生用 ?q= 自己重放同一份结果）；
     * feed 是首页队列（GET /feed/next），给"听首页"快捷方式用 —— 网页/服务端都不用改。
     */
    /**
     * 播放队列的来源。前四种与网页 #/play/<kind>/<id> 一一对应；search 需要关键词；
     * **single = 只播这一条**（id 走 query）：电视端遇到 WebView 放不了的编码（HEVC 等）时，
     * 交给原生 ExoPlayer —— 它走平台 MediaCodec，小米电视这类机器有硬件 HEVC 解码器（用户 2026-09-29：
     * "播放不了 hevc！我的小米电视硬件是支持的"）。
     */
    val supportedKinds = setOf("likes", "favorites", "history", "later", "search", "single")

    /** 播放器请求流地址时要带的头（会话 cookie）。 */
    fun streamHeaders(base: String): Map<String, String> {
        val cookie = CookieManager.getInstance().getCookie(base) ?: return emptyMap()
        return if (cookie.isBlank()) emptyMap() else mapOf("Cookie" to cookie)
    }

    private fun csrfFrom(cookie: String): String {
        cookie.split(';').forEach { part ->
            val kv = part.trim().split('=', limit = 2)
            if (kv.size == 2 && kv[0] == "zv_csrf") return kv[1]
        }
        return ""
    }

    /** 拉队列的结果：失败时带上服务端原话（别把 403"路径不在允许的媒体根里"说成"连不上服务器"）。 */
    class QueueResult(val list: List<Media>, val error: String)

    /** 拉一份列表当播放队列。history 的形状是 {list:[{media:{...}}]}，其余是 {list:[media...]}。 */
    fun queue(base: String, kind: String, cookie: String, query: String = ""): List<Media> = queueDetailed(base, kind, cookie, query).list

    fun queueDetailed(base: String, kind: String, cookie: String, query: String = ""): QueueResult {
        // single：query 就是那条媒体的 id，队列只有它一条
        if (kind == "single") {
            val id = query.trim()
            if (id.isEmpty()) return QueueResult(emptyList(), "")
            val reply = ZvApi.get(base + "/api/v1/media/" + enc(id), cookie)
            if (!reply.ok) return QueueResult(emptyList(), reply.errorMessage() + "（HTTP " + reply.status + "）")
            val item = reply.data() ?: return QueueResult(emptyList(), "")
            val mid = item.optString("id")
            val stream = item.optString("stream_url")
            if (mid.isEmpty() || stream.isEmpty()) return QueueResult(emptyList(), "")
            val prog = item.optJSONObject("progress")
            val position = prog?.optLong("position_ms") ?: 0L
            val completed = prog?.optBoolean("completed") ?: false
            val one = Media(
                id = mid,
                title = item.optString("title").ifBlank { mid },
                streamUrl = if (stream.startsWith("http")) stream else base + stream,
                durationMs = item.optLong("duration_ms"),
                resumeMs = if (position > 0 && !completed) position else 0L,
                gainDb = item.optDouble("gain_db", 0.0),
            )
            return QueueResult(listOf(one), "")
        }
        val path = when (kind) {
            "likes" -> "/api/v1/me/likes"
            "favorites" -> "/api/v1/me/favorites"
            "later" -> "/api/v1/me/watch-later"
            "history" -> "/api/v1/me/progress"
            "search" -> {
                if (query.isBlank()) return QueueResult(emptyList(), "")
                "/api/v1/media?per_page=100&q=" + java.net.URLEncoder.encode(query, "UTF-8")
            }
            "feed" -> "/api/v1/feed/next?limit=20"
            else -> return QueueResult(emptyList(), "")
        }
        val reply = ZvApi.get(base + path, cookie)
        if (!reply.ok) {
            // 服务端的原话 + 状态码：403 是"路径不在允许的媒体根里"，跟"连不上"完全两回事
            return QueueResult(emptyList(), reply.errorMessage() + "（HTTP " + reply.status + "）")
        }
        val list = reply.data()?.optJSONArray("list") ?: return QueueResult(emptyList(), "")
        val out = ArrayList<Media>(list.length())
        for (i in 0 until list.length()) {
            val raw = list.optJSONObject(i) ?: continue
            val item = if (kind == "history") raw.optJSONObject("media") else raw
            if (item == null) continue
            val id = item.optString("id")
            val stream = item.optString("stream_url")
            if (id.isEmpty() || stream.isEmpty()) continue
            // 续播：与网页端同一语义（position>0 且没看完才续）。history 的进度在外层对象上。
            val prog = if (kind == "history") raw.optJSONObject("progress") else item.optJSONObject("progress")
            val position = prog?.optLong("position_ms") ?: 0L
            val completed = prog?.optBoolean("completed") ?: false
            out.add(
                Media(
                    id = id,
                    title = item.optString("title").ifBlank { id },
                    streamUrl = if (stream.startsWith("http")) stream else base + stream,
                    durationMs = item.optLong("duration_ms"),
                    resumeMs = if (position > 0 && !completed) position else 0L,
                    gainDb = item.optDouble("gain_db", 0.0),
                )
            )
        }
        return QueueResult(out, "")
    }

    /** 进度回写（与网页端同一个接口）：写操作必须带 X-CSRF-Token。 */
    fun reportProgress(base: String, cookie: String, mediaId: String, positionMs: Long, durationMs: Long, completed: Boolean) {
        val body = JSONObject()
            .put("position_ms", positionMs)
            .put("duration_ms", durationMs)
            .put("completed", completed)
            .toString()
        ZvApi.patch(
            "$base/api/v1/me/progress/${java.net.URLEncoder.encode(mediaId, "UTF-8")}",
            body, cookie, csrfFrom(cookie),
        )
    }

    /** 一条媒体的互动状态（给原生播放页的图标栏用）。 */
    data class State(val favorite: Boolean, val watchLater: Boolean, val liked: Boolean)

    fun state(base: String, cookie: String, mediaId: String): State? {
        val reply = ZvApi.get("$base/api/v1/media/" + java.net.URLEncoder.encode(mediaId, "UTF-8"), cookie)
        val d = reply.data() ?: return null
        return State(
            favorite = d.optBoolean("favorite"),
            watchLater = d.optBoolean("watch_later"),
            liked = d.optString("reaction") == "like",
        )
    }

    /** 收藏 / 稍后再看 / 喜欢 的开关（与网页端同一批接口）。返回是否成功。 */
    fun toggleFavorite(base: String, cookie: String, mediaId: String, on: Boolean): Boolean =
        write(base, cookie, if (on) "POST" else "DELETE", "/api/v1/me/favorites/" + enc(mediaId), null)

    fun toggleLater(base: String, cookie: String, mediaId: String, on: Boolean): Boolean =
        write(base, cookie, if (on) "POST" else "DELETE", "/api/v1/me/watch-later/" + enc(mediaId), null)

    fun toggleLike(base: String, cookie: String, mediaId: String, on: Boolean): Boolean =
        if (on) write(base, cookie, "POST", "/api/v1/media/" + enc(mediaId) + "/reactions", "{\"kind\":\"like\"}")
        else write(base, cookie, "DELETE", "/api/v1/media/" + enc(mediaId) + "/reactions", null)

    /** B5：原生页也要跟着用户设置的倍速 —— 读的就是网页那份 user_prefs.playback_rate。 */
    fun playbackRate(base: String, cookie: String): Double {
        val data = ZvApi.get(base + "/api/v1/feed/settings", cookie).data() ?: return 1.0
        val rate = data.optDouble("playback_rate", 1.0)
        return if (rate > 0.01) rate else 1.0
    }

    /** 改倍速就写回服务端：网页与手机看到的是同一个设置（同一个 PATCH 接口）。 */
    fun setPlaybackRate(base: String, cookie: String, rate: Double): Boolean {
        val body = "{\"playback_rate\":" + String.format(java.util.Locale.US, "%.2f", rate) + "}"
        return write(base, cookie, "PATCH", "/api/v1/feed/settings", body)
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

    private fun write(base: String, cookie: String, method: String, path: String, body: String?): Boolean {
        val csrf = cookie.split(';').map { it.trim().split("=", limit = 2) }
            .firstOrNull { it.size == 2 && it[0] == "zv_csrf" }?.get(1) ?: ""
        return ZvApi.send("$base$path", method, body, cookie, csrf).ok
    }

    data class Media(
        val id: String,
        val title: String,
        val streamUrl: String,
        val durationMs: Long,
        val resumeMs: Long,
        /** 音量均一化的增益（dB，≤0 只衰减；0 = 不调）。用户 2026-09-26。 */
        val gainDb: Double,
    )
}
