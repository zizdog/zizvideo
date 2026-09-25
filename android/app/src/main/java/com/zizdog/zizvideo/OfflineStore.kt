package com.zizdog.zizvideo

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.webkit.CookieManager
import java.io.File

/**
 * ④ 手机离线缓存：把某一集下到本机，之后没网也能看（用户 2026-09-24："手机离线缓存（下载到本机看）"）。
 *
 * 为什么用系统的 [DownloadManager] 而不是自己写一套：系统自带断点重试、通知栏进度、省电调度，
 * 自己写只会更差。两个关键点：
 *   ① 流地址要鉴权 ⇒ 把 WebView 里那份会话 cookie 作为请求头带上（和播放器同一个做法）；
 *   ② 落点用 App 私有外部目录（`Android/data/<包名>/files/offline/`）⇒ 卸载应用自动清干净，
 *      也不用申请存储权限（Android 10+ 分区存储下这是唯一稳妥的做法）。
 *
 * 记住 mediaId → downloadId（SharedPreferences），这样重启应用后还能查到进度/完成状态。
 */
object OfflineStore {
    private const val DIR = "offline"
    private const val PREF = "zv_offline"

    /**
     * 下载完成的本地文件；没有就返回 null。
     * ⚠️ 目录必须与 enqueue 里的 setDestinationInExternalFilesDir 完全一致（都是 Movies/offline）——
     * 一个用 null、一个用 DIRECTORY_MOVIES 会变成"下完了但永远查不到"（这个坑很隐蔽，写一次记下来）。
     */
    fun fileFor(context: Context, mediaId: String): File {
        val safe = mediaId.replace(Regex("[^A-Za-z0-9_]"), "_")
        return File(File(context.getExternalFilesDir(Environment.DIRECTORY_MOVIES), DIR), "$safe.mp4")
    }

    /**
     * 元数据副档（同名 .json）：原始 id / 标题 / 封面 / 时长。
     * 为什么需要它：文件名做过安全替换、且只有 id —— 网页只能拿 id 去 API 查标题，
     * 查不到（或没网）就只剩一串 "med_xxxx" 看不出是什么，也永远没有封面（用户 2026-09-25 报障）。
     * 副档在**下载那一刻**由网页给的元数据写入，于是离线也能显示标题和封面。
     */
    private fun metaFile(context: Context, mediaId: String): File =
        File(fileFor(context, mediaId).absolutePath.removeSuffix(".mp4") + ".json")

    private fun writeMeta(context: Context, mediaId: String, json: String) {
        try {
            val f = metaFile(context, mediaId)
            // ⚠️ 目录必须先建：offline/ 是 DownloadManager 开始下载时才创建的，先写副档会 ENOENT
            //（实测：副档没写成 ⇒ 列表里又只剩一串 med_xxxx，正是这次要修的毛病）
            f.parentFile?.mkdirs()
            f.writeText(json)
        } catch (e: Exception) {
            android.util.Log.w("zv-offline", "写元数据失败: ${e.message}")
        }
    }

    private fun readMeta(context: Context, mediaId: String): String? {
        val f = metaFile(context, mediaId)
        if (!f.exists()) return null
        return try {
            f.readText().ifBlank { null }
        } catch (e: Exception) {
            null
        }
    }

    private fun escape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ")

    fun downloaded(context: Context, mediaId: String): File? {
        val f = fileFor(context, mediaId)
        return if (f.exists() && f.length() > 0) f else null
    }

    fun localUri(context: Context, mediaId: String): String? =
        downloaded(context, mediaId)?.let { Uri.fromFile(it).toString() }

    /** 开始下载；返回 downloadId（-1 = 排队失败）。metaJson 见 metaFile 的说明。 */
    fun enqueue(context: Context, base: String, mediaId: String, title: String, metaJson: String = ""): Long {
        if (base.isBlank()) return -1
        val cookie = CookieManager.getInstance().getCookie(base) ?: ""
        val url = base.trimEnd('/') + "/api/v1/media/" + Uri.encode(mediaId) + "/stream"
        fileFor(context, mediaId).delete() // 重新缓存：先清掉旧的半个文件
        val req = DownloadManager.Request(Uri.parse(url))
            .setTitle(title.ifBlank { mediaId })
            .setDescription("离线缓存")
            .setAllowedOverMetered(true)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        if (cookie.isNotBlank()) req.addRequestHeader("Cookie", cookie)
        // 用 App 私有外部目录（DownloadManager 官方支持的目标之一，不需要存储权限）
        req.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_MOVIES, "$DIR/${fileFor(context, mediaId).name}")
        // 先写元数据（标题/封面/原始 id），排在下载之前 —— 下到一半也是"看得懂的一条"
        if (metaJson.isNotBlank()) {
            writeMeta(context, mediaId, metaJson)
        } else if (title.isNotBlank()) {
            writeMeta(context, mediaId, "{\"id\":\"" + escape(mediaId) + "\",\"title\":\"" + escape(title) + "\"}")
        }
        return try {
            val id = manager(context).enqueue(req)
            prefs(context).edit().putLong(mediaId, id).apply()
            id
        } catch (e: Exception) {
            android.util.Log.w("zv-offline", "排队下载失败: ${e.message}")
            -1L
        }
    }

    /** 下载进度：null = 没在下载（可能已完成、可能没开始）；0..100 = 进行中。 */
    fun progress(context: Context, mediaId: String): Int? {
        val id = prefs(context).getLong(mediaId, -1L)
        if (id < 0) return null
        val q = DownloadManager.Query().setFilterById(id)
        return try {
            manager(context).query(q).use { cur ->
                if (!cur.moveToFirst()) return null
                val status = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                when (status) {
                    DownloadManager.STATUS_SUCCESSFUL -> null // 完成：由 downloaded() 判
                    DownloadManager.STATUS_FAILED -> null
                    DownloadManager.STATUS_PAUSED -> null
                    else -> {
                        val total = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                        val done = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                        if (total > 0) ((done * 100) / total).toInt().coerceIn(0, 99) else 0
                    }
                }
            }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 下载失败的原因（给界面/日志用）：系统 DownloadManager 的失败原因码 + 本地化文案。
     * 为什么要这个：点「缓存」后如果只是"没反应"，用户和我都查不出为什么（实测踩到）。
     */
    fun failReason(context: Context, mediaId: String): String? {
        val id = prefs(context).getLong(mediaId, -1L)
        if (id < 0) return null
        return try {
            manager(context).query(DownloadManager.Query().setFilterById(id)).use { cur ->
                if (!cur.moveToFirst()) return "任务不在了（可能被系统清掉）"
                val status = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                if (status != DownloadManager.STATUS_FAILED) return null
                val reason = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                when (reason) {
                    DownloadManager.ERROR_INSUFFICIENT_SPACE -> "手机空间不够"
                    DownloadManager.ERROR_FILE_ERROR -> "写文件失败（目标目录不可写？）"
                    DownloadManager.ERROR_HTTP_DATA_ERROR, DownloadManager.ERROR_UNHANDLED_HTTP_CODE -> "服务器拒绝了这次下载（会话过期？）"
                    DownloadManager.ERROR_CANNOT_RESUME, DownloadManager.ERROR_TOO_MANY_REDIRECTS -> "网络/重定向问题"
                    DownloadManager.ERROR_UNKNOWN -> "未知错误（reason=$reason）"
                    else -> "下载失败（reason=$reason）"
                }
            }
        } catch (e: Exception) {
            "查询下载状态失败：" + e.message
        }
    }

    /** 原始状态（诊断用）：status/reason/进度/总量 —— 点「缓存」没反应时看这个。 */
    fun rawStatus(context: Context, mediaId: String): String {
        val id = prefs(context).getLong(mediaId, -1L)
        if (id < 0) return "no-download-id"
        return try {
            manager(context).query(DownloadManager.Query().setFilterById(id)).use { cur ->
                if (!cur.moveToFirst()) return "row-gone"
                val status = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                val reason = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                val done = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                val total = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                val uri = cur.getString(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI)) ?: ""
                "id=$id status=$status reason=$reason done=$done total=$total uri=$uri"
            }
        } catch (e: Exception) {
            "query-failed:" + e.message
        }
    }

    /** 删除缓存（包括"正在下载"的那次）。返回是否删掉了东西。 */
    fun delete(context: Context, mediaId: String): Boolean {
        val p = prefs(context)
        val id = p.getLong(mediaId, -1L)
        var removed = false
        if (id >= 0) {
            try {
                manager(context).remove(id)
                removed = true
            } catch (e: Exception) {
                // 下载已经结束了 remove 会抛，继续删文件
            }
            p.edit().remove(mediaId).apply()
        }
        val f = fileFor(context, mediaId)
        if (f.exists()) {
            removed = f.delete() || removed
        }
        metaFile(context, mediaId).delete()
        return removed
    }

    /**
     * 已缓存清单的 JSON（给网页「我的 → 已缓存」）：
     * `[{"id":"med_x","size":123,"title":"第 1 集","cover":"/api/v1/media/med_x/cover","duration_ms":90000}]`。
     * id/标题/封面/时长来自下载时写的副档；没有副档（老缓存）就只给 id + size，网页再去 API 补。
     */
    fun listJson(context: Context): String {
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MOVIES), DIR)
        val files = dir.listFiles() ?: return "[]"
        val arr = org.json.JSONArray()
        for (f in files) {
            if (!f.isFile || f.length() <= 0 || !f.name.endsWith(".mp4")) continue
            val fromName = f.name.removeSuffix(".mp4")
            val o = org.json.JSONObject()
            try {
                readMeta(context, fromName)?.let { meta ->
                    val parsed = org.json.JSONObject(meta)
                    val keys = parsed.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        o.put(k, parsed.get(k))
                    }
                }
            } catch (e: Exception) {
                android.util.Log.w("zv-offline", "副档读不出来（用文件名兜底）: ${e.message}")
            }
            if (o.optString("id").isBlank()) o.put("id", fromName)
            o.put("size", f.length())
            arr.put(o)
        }
        return arr.toString()
    }

    /** 已缓存了多少集 + 占多大（播放页显示"已缓存 N 集 / X MB"用）。 */
    fun usage(context: Context): Pair<Int, Long> {
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MOVIES), DIR)
        val files = dir.listFiles() ?: return 0 to 0L
        var count = 0
        var bytes = 0L
        for (f in files) {
            if (f.isFile && f.length() > 0) {
                count++
                bytes += f.length()
            }
        }
        return count to bytes
    }

    private fun manager(context: Context): DownloadManager =
        context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    private fun prefs(context: Context) = context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
}
