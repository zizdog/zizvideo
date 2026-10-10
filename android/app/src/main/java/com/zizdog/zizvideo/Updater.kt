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

    /**
     * 默认更新源（镜像站）。这是**唯一**的更新源：Intent / 网页传进来的 base 一律不认
     * （只有可调试包才认自测口，见 resolveBase）。
     */
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
     * 更新源**只能**是代码内常量 `DEFAULT_BASE`。`hint` 只有可调试包（allowOverride=true）才被采纳，
     * 而且是给自测/模拟器用的（`--es update_base http://10.0.2.2:17802/apps/zizvideo`）。
     *
     * 为什么外面的 base 一个都不能认：LoginActivity 是 `exported`，本机任何 App 都能塞一个
     * `update_base` 进来把更新链换成自己的服务器 —— 清单（含 sha256）也归它写，等于装任意 APK。
     */
    fun resolveBase(hint: String?, allowOverride: Boolean): String {
        val h = hint?.trim().orEmpty()
        if (allowOverride && isHttpUrl(h)) return h.trimEnd('/')
        return DEFAULT_BASE
    }

    /** 是不是 http(s) 地址（判自测口时用，避免把 "httpfoo" 这种当地址）。 */
    fun isHttpUrl(value: String?): Boolean {
        val v = value?.trim().orEmpty()
        if (!v.startsWith("https://") && !v.startsWith("http://")) return false
        return v.substringAfter("://").substringBefore('/').isNotBlank()
    }

    /**
     * 版本号比大小。本项目的规矩是"末段是 0～10 的计数器"（0.4.9 → 0.4.10 → 0.5.0），
     * 所以逐段按**数字**比就对：0.4.10 > 0.4.9（字符串比会反），0.5.0 > 0.4.10。
     */
    fun isNewer(remote: String, local: String): Boolean {
        val a = versionParts(remote)
        val b = versionParts(local)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /** "0.4.10" → [0,4,10]；段里带后缀（0.6.3-mvp）只取开头的数字，取不到的段算 0。 */
    private fun versionParts(v: String): List<Int> =
        v.trim().split('.').map { it.takeWhile { c -> c.isDigit() }.toIntOrNull() ?: 0 }

    /**
     * sha256 必须是 **64 位小写 hex**（发布侧 tools/make-app-index.py 就是这么写的）。
     * 缺失、大写、短了、带别的字符 —— 一律算格式不对。
     */
    fun isValidSha256(value: String?): Boolean {
        val v = value?.trim().orEmpty()
        if (v.length != 64) return false
        return v.all { it in '0'..'9' || it in 'a'..'f' }
    }

    /**
     * 期望的 sha256 与实测值是否相符。**fail-closed**：期望值缺失或格式不对 ⇒ false。
     * 原来写的是 `sha256.isNotBlank() && equals(ignoreCase)` —— 清单里没写 sha256 就等于
     * **完全不校验**（更新链可被换成任意 APK），这正是要堵的洞。
     */
    fun verifyDigest(expected: String?, actual: String?): Boolean {
        val e = expected?.trim().orEmpty()
        if (!isValidSha256(e)) return false
        return e == actual?.trim().orEmpty()
    }

    /**
     * 安装前再核一次**文件本身**：下载目录在 App 外部存储（`Android/data/.../update`），
     * 别的进程能改它；交给系统安装器之前必须确认手里这份就是清单说的那份。
     */
    fun verifyFile(file: File, expected: String?): Boolean =
        file.isFile && verifyDigest(expected, sha256(file))

    /**
     * 清单里的 `file` 只允许**同源相对路径**（`android/zizvideo-android-0.4.4.apk`）。
     * 出现 `http(s)://`、协议相对 `//host/...`、绝对路径、`..`、空白一律拒绝（返回 null）——
     * 否则清单自己就能把下载引到别人的服务器上（清单也来自更新源）。
     */
    fun resolveDownloadUrl(base: String, file: String?): String? {
        val f = file?.trim().orEmpty()
        if (f.isEmpty()) return null
        if (f.contains("://")) return null
        if (f.startsWith("/") || f.startsWith("\\")) return null
        if (f.contains("..") || f.contains('\\')) return null
        if (f.any { it.isWhitespace() }) return null
        return base.trimEnd('/') + "/" + f
    }

    /**
     * 拉更新清单；没有新版本返回 null。任何网络/解析问题、以及**清单本身不可信**
     * （file 不是同源相对路径 / sha256 缺失或格式不对）都抛异常，交给调用方如实说。
     *
     * 更新源由 resolveBase 定：release 包里 `hint` 会被整个忽略。
     */
    fun check(context: Context, hint: String? = null): Update? {
        val debug = BuildFlags.isDebuggable(context)
        val base = resolveBase(hint, debug)
        if (!hint.isNullOrBlank() && !debug) {
            Log.w(TAG, "忽略外部传入的更新源（只有可调试包才认自测口）")
        }
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
        // 先验清单、再比版本：清单不可信时"已是最新"也是谎话
        val url = resolveDownloadUrl(base, file)
            ?: throw IllegalStateException("更新清单的 file 不是同源相对路径，已拒绝")
        val sha = obj.optString("sha256").trim()
        if (!isValidSha256(sha)) {
            throw IllegalStateException("更新清单缺少有效的 sha256（64 位小写 hex），已拒绝更新")
        }
        Log.i(TAG, "更新清单：最新=$version 当前=$local file=$file")
        if (!isNewer(version, local)) return null
        return Update(version, url, sha, obj.optLong("size"))
    }

    /**
     * 下载 APK 到 App 私有外部目录（不用存储权限），边下边报进度；下完**核对 sha256**，
     * 不一致直接删掉并报错（宁可让用户重试，也不许装一个坏包）。
     * sha256 缺失/格式不对同样拒绝（fail-closed，见 verifyDigest）。
     */
    fun download(context: Context, update: Update, onProgress: (Int) -> Unit): File {
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
        if (!verifyDigest(update.sha256, digest)) {
            tmp.delete()
            throw IllegalStateException("安装包校验不过（sha256 缺失、格式不对或与文件不符），已丢弃，请重试")
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
