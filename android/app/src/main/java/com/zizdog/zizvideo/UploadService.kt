package com.zizdog.zizvideo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.provider.OpenableColumns
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 用户上传（UGC）的后台搬运：系统文件选择器（SAF）选中的视频 → 同一套分片接口 → 定稿待审。
 *
 * 为什么是**前台服务**：手机传大视频要几分钟，切后台/息屏会被系统掐掉；用户明确要求"息屏不断"。
 * 接口与网页端完全一致（POST /api/v1/uploads → PUT 分片 → POST .../finish），不另立契约；
 * 断点续传同样是"服务端 .zvpart 为准"：一片失败就 GET 一次续传位置接着传。
 */
class UploadService : Service() {

    companion object {
        const val EXTRA_URIS = "uris"
        private const val TAG = "zv-upload"
        private const val CHANNEL = "zv-upload"
        private const val NOTIF_ID = 2001
        private const val CHUNK = 8 * 1024 * 1024

        fun start(context: Context, uris: List<Uri>) {
            val intent = Intent(context, UploadService::class.java)
            intent.putParcelableArrayListExtra(EXTRA_URIS, ArrayList(uris))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private val worker = Executors.newSingleThreadExecutor()
    private var manager: NotificationManager? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL, "上传", NotificationManager.IMPORTANCE_LOW)
            channel.description = "用户上传的后台进度"
            manager?.createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val uris: List<Uri> = intent?.getParcelableArrayListExtra(EXTRA_URIS) ?: emptyList()
        startForegroundCompat(notify("准备上传…", 0, 0))
        if (uris.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }
        worker.execute {
            val results = ArrayList<String>()
            uris.forEachIndexed { index, uri ->
                val label = "${index + 1}/${uris.size}"
                try {
                    Log.i(TAG, "开始上传 $label：" + nameOf(uri))
                    uploadOne(uri) { pct -> update(notify("上传 $label · $pct%", index, uris.size, pct)) }
                    results.add("✓ " + nameOf(uri))
                } catch (e: Exception) {
                    results.add("✗ " + nameOf(uri) + "：" + (e.message ?: "失败"))
                }
            }
            finish(results)
        }
        return START_NOT_STICKY
    }

    private fun startForegroundCompat(notification: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceCompat.startForeground(this, NOTIF_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, notification)
            }
            Log.i(TAG, "前台服务已启动 id=$NOTIF_ID type=dataSync")
        } catch (e: Exception) {
            Log.w(TAG, "前台服务启动失败：" + e.message)
            // 前台服务起不来也别直接崩：把错误如实放进通知里（自用场景常见于系统限制）
            manager?.notify(NOTIF_ID, notify("上传服务无法保持后台：" + (e.message ?: ""), 0, 0))
        }
    }

    private fun notify(text: String, index: Int, total: Int, pct: Int = 0): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("上传视频")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, pct.coerceIn(0, 100), false)
        if (total > 0) builder.setSubText("${index + 1}/$total")
        return builder.build()
    }

    private fun update(notification: Notification) {
        manager?.notify(NOTIF_ID, notification)
    }

    private fun finish(results: List<String>) {
        val text = results.joinToString("；").ifBlank { "没有可上传的文件" }
        val done = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("上传结束")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .build()
        Log.i(TAG, "上传结束：" + text)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        manager?.notify(NOTIF_ID + 1, done)
        stopSelf()
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- 上传本体

    private fun base(): String = Prefs(this).baseUrl

    private fun cookie(): String = CookieManager.getInstance().getCookie(base()) ?: ""

    private fun csrf(cookie: String): String {
        cookie.split(';').forEach { part ->
            val kv = part.trim().split('=', limit = 2)
            if (kv.size == 2 && kv[0] == "zv_csrf") return kv[1]
        }
        return ""
    }

    private class Meta(val name: String, val size: Long)

    private fun metaOf(uri: Uri): Meta {
        var name = "upload.mp4"
        var size = -1L
        resolver().query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIdx >= 0 && !cursor.isNull(nameIdx)) name = cursor.getString(nameIdx)
                if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) size = cursor.getLong(sizeIdx)
            }
        }
        return Meta(name, size)
    }

    private fun resolver(): ContentResolver = contentResolver

    /**
     * 传一个 URI：开会话 → 分片 PUT（失败就回读断点续传一次）→ 定稿。
     * size 未知（少数 provider）时先按流长度算：读不满就报错，不做假进度。
     */
    private fun uploadOne(uri: Uri, onProgress: (Int) -> Unit) {
        val meta = metaOf(uri)
        val total = meta.size
        if (total <= 0) throw IllegalStateException("读不到文件大小（系统选择器没给 SIZE）")
        val started = ZvApi.send("${base()}/api/v1/uploads", "POST",
            JSONObject().put("name", meta.name).put("size", total).toString(), cookie(), csrf(cookie()))
        if (!started.ok) throw IllegalStateException(started.errorMessage())
        val id = started.data()?.optJSONObject("item")?.optString("id") ?: ""
        if (id.isEmpty()) throw IllegalStateException("服务器没给 upload_id")

        var offset = 0L
        var attempt = 0
        while (offset < total) {
            val end = minOf(total, offset + CHUNK)
            try {
                resolver().openInputStream(uri)?.use { input ->
                    skipFully(input, offset)
                    val buf = ByteArray((end - offset).toInt())
                    val read = readFully(input, buf)
                    if (read <= 0) throw IllegalStateException("文件读完了但还差 ${total - offset} 字节")
                    val reply = putChunk(id, buf, read, offset, total)
                    if (!reply.ok) throw IllegalStateException(reply.errorMessage())
                } ?: throw IllegalStateException("打不开这个文件")
                offset = end
                attempt = 0
                onProgress(((offset * 100) / total).toInt())
            } catch (e: Exception) {
                if (attempt >= 2) throw e
                attempt += 1
                // 回读服务端真实断点：它可能已经收下了这一片（网络超时但服务端写完了）
                offset = serverOffset(id, offset)
                onProgress(((offset * 100) / total).toInt())
            }
        }
        val finished = ZvApi.send("${base()}/api/v1/uploads/$id/finish", "POST", null, cookie(), csrf(cookie()))
        if (!finished.ok) throw IllegalStateException(finished.errorMessage())
        onProgress(100)
    }

    private fun serverOffset(id: String, fallback: Long): Long {
        val reply = ZvApi.get("${base()}/api/v1/uploads/$id", cookie())
        if (!reply.ok) return fallback
        val n = reply.data()?.optJSONObject("item")?.optLong("received_bytes") ?: fallback
        return if (n in 0..fallback) n else fallback
    }

    private fun putChunk(id: String, buf: ByteArray, len: Int, offset: Long, total: Long): ZvApi.Reply {
        val url = URL("${base()}/api/v1/uploads/$id")
        val conn = url.openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "PUT"
            conn.connectTimeout = 10000
            conn.readTimeout = 60000
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(len)
            conn.setRequestProperty("Content-Type", "application/octet-stream")
            conn.setRequestProperty("Content-Range", "bytes $offset-${offset + len - 1}/$total")
            val ck = cookie()
            if (ck.isNotBlank()) conn.setRequestProperty("Cookie", ck)
            val token = csrf(ck)
            if (token.isNotBlank()) conn.setRequestProperty("X-CSRF-Token", token)
            conn.outputStream.use { it.write(buf, 0, len) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            ZvApi.Reply(status, text, emptyList())
        } finally {
            conn.disconnect()
        }
    }

    private fun skipFully(input: InputStream, bytes: Long) {
        var left = bytes
        while (left > 0) {
            val skipped = input.skip(left)
            if (skipped > 0) { left -= skipped; continue }
            if (input.read() < 0) throw IllegalStateException("文件比声明的短")
            left -= 1
        }
    }

    private fun readFully(input: InputStream, buf: ByteArray): Int {
        var total = 0
        while (total < buf.size) {
            val n = input.read(buf, total, buf.size - total)
            if (n < 0) break
            total += n
        }
        return total
    }

    private fun nameOf(uri: Uri): String = try { metaOf(uri).name } catch (e: Exception) { uri.lastPathSegment ?: "文件" }
}
