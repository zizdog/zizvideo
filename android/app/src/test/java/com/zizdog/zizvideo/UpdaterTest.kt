package com.zizdog.zizvideo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 更新链的门禁（P0）。
 *
 * 修之前会失败在哪：
 *  · 更新源认外部传进来的 `update_base`（LoginActivity 是 exported），本机任何 App 都能把更新链
 *    换成自己的服务器 —— 连带 sha256 也归它写，等于装任意 APK；
 *  · `download()` 里写的是 `sha256.isNotBlank() && …`：清单里**不写** sha256 就等于完全不校验；
 *  · 清单里的 `file` 允许是 `http(s)://...`，下载能被引到别人的服务器上。
 */
class UpdaterTest {

    /** 64 位小写 hex（合法 sha256 的形状）。 */
    private val digest = "3a".repeat(32)

    /* ---------------- 版本号：每 10 进一（0.4.9 → 0.4.10 → 0.5.0） ---------------- */

    @Test
    fun versionCounterRollsAtTen() {
        // 本项目的规矩：末段是 0～10 的计数器，数到 10 进前一段（不存在 0.4.11）
        assertTrue(Updater.isNewer("0.4.10", "0.4.9"))
        assertTrue(Updater.isNewer("0.5.0", "0.4.10"))
        // 反方向一律"没有新版"（字符串比会在这里出错：0.4.9 > 0.4.10）
        assertFalse(Updater.isNewer("0.4.9", "0.4.10"))
        assertFalse(Updater.isNewer("0.4.10", "0.5.0"))
        assertFalse(Updater.isNewer("0.4.10", "0.4.10"))
    }

    @Test
    fun everySegmentIsComparedAsNumber() {
        assertTrue(Updater.isNewer("0.2.10", "0.2.9"))
        assertFalse(Updater.isNewer("0.2.9", "0.2.10"))
        assertTrue(Updater.isNewer("1.0.0", "0.9.10"))
        assertTrue(Updater.isNewer("0.4.5", "0.4.4"))
        assertTrue(Updater.isNewer("0.6.3-mvp", "0.6.2")) // 后缀只取开头数字
        assertFalse(Updater.isNewer("0.6.3-mvp", "0.6.3"))
        // 拿不到本地版本（"?"）时也不能说"没有新版"，否则更新永远不提示
        assertTrue(Updater.isNewer("0.4.4", "?"))
    }

    /* ---------------- sha256：缺失/格式不对/不符 ⇒ 一律不认 ---------------- */

    @Test
    fun digestMustBeA64CharLowercaseHex() {
        assertTrue(Updater.isValidSha256(digest))
        assertFalse(Updater.isValidSha256(null))
        assertFalse(Updater.isValidSha256(""))
        assertFalse(Updater.isValidSha256("   "))
        assertFalse(Updater.isValidSha256(digest.dropLast(1)))          // 短了
        assertFalse(Updater.isValidSha256(digest + "a"))                // 长了
        assertFalse(Updater.isValidSha256(digest.uppercase()))          // 大写不算合法
        assertFalse(Updater.isValidSha256("3g".repeat(32)))             // 不是 hex
        assertTrue(Updater.isValidSha256("  $digest  "))                // 首尾空白是允许的（JSON 里常见的脏数据）
    }

    @Test
    fun verifyDigestIsFailClosed() {
        assertTrue(Updater.verifyDigest(digest, digest))
        // 原来这两条都是"通过"（isNotBlank 让缺失 = 不校验）
        assertFalse(Updater.verifyDigest(null, digest))
        assertFalse(Updater.verifyDigest("", digest))
        assertFalse(Updater.verifyDigest(digest.dropLast(1), digest))
        assertFalse(Updater.verifyDigest(digest.uppercase(), digest))
        assertFalse(Updater.verifyDigest(digest, "b".repeat(64)))        // 跟文件不符
        assertFalse(Updater.verifyDigest(digest, null))
    }

    @Test
    fun verifyFileChecksTheBytesOnDisk() {
        val f = File.createTempFile("zv-update-test", ".apk")
        try {
            f.writeText("abc")
            // sha256("abc") 的标准值：既验了 verifyDigest，也验了 Updater 自己的 sha256 实现
            val abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            assertTrue(Updater.verifyFile(f, abc))
            assertFalse(Updater.verifyFile(f, "0".repeat(64)))            // 文件被换过
            assertFalse(Updater.verifyFile(f, ""))                        // 清单没写 sha256
            assertFalse(Updater.verifyFile(File(f.parentFile, "zv-not-exist.apk"), abc))
        } finally {
            f.delete()
        }
    }

    /* ---------------- 清单里的 file 只许同源相对路径 ---------------- */

    @Test
    fun manifestFileMustStayOnTheSameOrigin() {
        val base = "https://mirror.zizdog.com:8888/apps/zizvideo"
        assertEquals(
            "$base/android/zizvideo-android-0.4.10.apk",
            Updater.resolveDownloadUrl(base, "android/zizvideo-android-0.4.10.apk"),
        )
        // 清单被改过：把下载引到别人的服务器一律拒绝
        assertNull(Updater.resolveDownloadUrl(base, "http://evil.example/x.apk"))
        assertNull(Updater.resolveDownloadUrl(base, "https://evil.example/x.apk"))
        assertNull(Updater.resolveDownloadUrl(base, "//evil.example/x.apk"))
        assertNull(Updater.resolveDownloadUrl(base, "/etc/passwd"))
        assertNull(Updater.resolveDownloadUrl(base, "android/../../secret.apk"))
        assertNull(Updater.resolveDownloadUrl(base, "..\\x.apk"))
        assertNull(Updater.resolveDownloadUrl(base, "android/x apk"))
        assertNull(Updater.resolveDownloadUrl(base, ""))
        assertNull(Updater.resolveDownloadUrl(base, null))
    }

    /* ---------------- 更新源只能是常量（除非可调试包） ---------------- */

    @Test
    fun updateSourceIsConstantUnlessDebugBuild() {
        assertEquals(Updater.DEFAULT_BASE, Updater.resolveBase(null, false))
        assertEquals(Updater.DEFAULT_BASE, Updater.resolveBase("", false))
        // release 包：外部 Intent 传什么都被忽略（LoginActivity 是 exported，这条最要紧）
        assertEquals(Updater.DEFAULT_BASE, Updater.resolveBase("https://evil.example/apps/zizvideo", false))
        assertEquals(Updater.DEFAULT_BASE, Updater.resolveBase("http://10.0.2.2:17802/apps/zizvideo", false))
        // 可调试包才认自测口（模拟器上的自测地址）
        assertEquals(
            "http://10.0.2.2:17802/apps/zizvideo",
            Updater.resolveBase("http://10.0.2.2:17802/apps/zizvideo", true),
        )
        assertEquals("https://x.example/a/b", Updater.resolveBase("https://x.example/a/b/", true))
        // 不是 http(s) 地址就当没传（file:// / 裸字符串都不能变成更新源）
        assertEquals(Updater.DEFAULT_BASE, Updater.resolveBase("file:///tmp/x", true))
        assertEquals(Updater.DEFAULT_BASE, Updater.resolveBase("httpfoo", true))
        assertEquals(Updater.DEFAULT_BASE, Updater.resolveBase("http://", true))
        assertEquals(Updater.DEFAULT_BASE, Updater.resolveBase("https:///x", true))
    }
}
