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
    val supportedKinds = setOf("likes", "favorites", "history", "later", "search")

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

    /** 拉一份列表当播放队列。history 的形状是 {list:[{media:{...}}]}，其余是 {list:[media...]}。 */
    fun queue(base: String, kind: String, cookie: String, query: String = ""): List<Media> {
        val path = when (kind) {
            "likes" -> "/api/v1/me/likes"
            "favorites" -> "/api/v1/me/favorites"
            "later" -> "/api/v1/me/watch-later"
            "history" -> "/api/v1/me/progress"
            "search" -> {
                if (query.isBlank()) return emptyList()
                "/api/v1/media?per_page=100&q=" + java.net.URLEncoder.encode(query, "UTF-8")
            }
            "feed" -> "/api/v1/feed/next?limit=20"
            else -> return emptyList()
        }
        val reply = ZvApi.get(base + path, cookie)
        if (!reply.ok) return emptyList()
        val list = reply.data()?.optJSONArray("list") ?: return emptyList()
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
                )
            )
        }
        return out
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

    data class Media(
        val id: String,
        val title: String,
        val streamUrl: String,
        val durationMs: Long,
        val resumeMs: Long,
    )
}
