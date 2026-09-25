package com.zizdog.zizvideo

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 自动检查更新（用户 2026-09-25："给 app 加自动检查更新，我不想再一次次的手动下载安装了"）。
 *
 * 更新源是镜像站上的一份小清单（发布侧 tools/make-app-index.py + tools/publish-mirror.sh 写）：
 *     <base>/android.json
 *     {"app":"zizvideo","platform":"android","version":"0.2.4","server_version":"0.2.10-mvp",
 *      "file":"android/zizvideo-android-0.2.4.apk","sha256":"…","size":8039743}
 *   · 单独一份、不塞进面板读的 manifest.json：那个 schema 是面板的契约，混进去有被误当产物的风险；
 *   · APK 放在 apps/zizvideo/android/ 这个**稳定路径**：版本目录会被发布流程 prune 掉。
 *
 * 为什么不用系统的 DownloadManager 下载更新包：它要求网络处于 VALIDATED 状态（实测模拟器/部分
 * 盒子上会一直 PENDING，离线缓存那次就踩过）—— 更新这件事等不起，所以自己拉，进度可控。
 *
 * 为什么"安装"一定要用户点一下：安卓不允许普通应用静默安装（系统安装器界面必须由人确认）。
 * 所以本模块做到的是：**自动检查 + 自动下载 + 直接拉起系统安装器**，用户只在系统界面点一下「安装」。
 */
object Updater {

    /** 默认更新源（镜像站）。可用启动参数 update_base 覆盖（自测/模拟器用）。 */
    const val DEFAULT_BASE = "https://mirror.zizdog.com:8888/apps/zizvideo"

    private const val TAG = "zv-update"

    data class Update(val version: String, val url: String, val sha256: String, val size: Long)

    fun appVersion(context: Context): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "?"
    } catch (e: Exception) {
        "?"
    }

    fun appVersionCode(context: Context): Long = try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
    } catch (e: Exception) {
        0L
    }

    /**
     * 版本号比大小。本项目的规矩是"末段是 0～10 的计数器"（0.2.9 → 0.2.10 → 0.3.0），
     * 所以逐段按数字比就对：0.2.10 > 0.2.9（字符串比会错），0.3.0 > 0.2.10。
     */
    fun isNewer(remote: String, local: String): Boolean {
        val a = remote.split(".")
        val b = local.split(".")
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrNull(i)?.filter { it.isDigit() }?.toIntOrNull() ?: 0
            val y = b.getOrNull(i)?.filter { it.isDigit() }?.toIntOrNull() ?: 0
            if (x != y) return x > y
        }
        return false
    }

    /** 拉更新清单；没有新版本返回 null。任何网络/解析问题都抛异常，交给调用方决定怎么说话。 */
    fun check(context: Context, base: String): Update? {
        val indexUrl = base.trimEnd('/') + "/android.json"
        val text = httpGet(indexUrl)
        val obj = JSONObject(text)
        val version = obj.optString("version")
        val file = obj.optString("file")
        val local = appVersion(context)
        if (version.isBlank() || file.isBlank()) {
            Log.w(TAG, "清单字段不全：version=$version file=$file")
            return null
        }
        val url = if (file.startsWith("http")) file else base.trimEnd('/') + "/" + file.trimStart('/')
        Log.i(TAG, "更新清单：最新=$version 当前=$local file=$file")
        if (!isNewer(version, local)) return null
        return Update(version, url, obj.optString("sha256"), obj.optLong("size"))
    }

    /**
     * 下载 APK 到 App 私有外部目录（不用存储权限），边下边报进度；下完**核对 sha256**，
     * 不一致直接删掉并报错（宁可让用户重试，也不许装一个坏包）。
     */
    fun download(context: Context, base: String, update: Update, onProgress: (Int) -> Unit): File {
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "update")
        dir.mkdirs()
        val name = update.url.substringAfterLast('/').ifBlank { "zizvideo-android-${update.version}.apk" }
        val out = File(dir, name)
        val tmp = File(dir, name + ".part")
        if (tmp.exists()) tmp.delete()

        val conn = (URL(update.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 30000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "zizvideo-android/" + appVersion(context))
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("服务器返回 HTTP $code")
            val total = conn.contentLengthLong.takeIf { it > 0 } ?: update.size
            conn.inputStream.use { input ->
                FileOutputStream(tmp).use { output ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var lastPct = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        output.write(buf, 0, n)
                        done += n
                        if (total > 0) {
                            val pct = ((done * 100) / total).toInt().coerceIn(0, 100)
                            if (pct != lastPct) { lastPct = pct; onProgress(pct) }
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
        val digest = sha256(tmp)
        if (update.sha256.isNotBlank() && !digest.equals(update.sha256, ignoreCase = true)) {
            tmp.delete()
            throw IllegalStateException("下载的安装包校验不符（可能被截断），已丢弃，请重试")
        }
        if (update.size > 0 && tmp.length() != update.size) {
            val got = tmp.length()
            tmp.delete()
            throw IllegalStateException("安装包大小不符（期望 ${update.size}，实际 ${got}），已丢弃")
        }
        if (out.exists()) out.delete()
        if (!tmp.renameTo(out)) throw IllegalStateException("保存安装包失败")
        onProgress(100)
        Log.i(TAG, "下载完成：${out.absolutePath}（${out.length()} B，sha256 ${digest.take(16)}…）")
        return out
    }

    /** 安卓 8+ 要用户授一次"安装未知应用"；返回 false 就得先引导去设置。 */
    fun canInstall(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.packageManager.canRequestPackageInstalls()
        else true

    /** 拉起系统安装器（用户点一下「安装」即完成升级）。 */
    fun install(context: Context, apk: File): Intent {
        val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", apk)
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    private fun httpGet(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10000
            readTimeout = 15000
            instanceFollowRedirects = true
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
