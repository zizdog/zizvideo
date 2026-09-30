package com.zizdog.zizvideo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 局域网自动探测的纯逻辑门禁（用户 2026-09-28："首次登录自动探测局域网的服务 zizvideo 服务器"）。
 *
 * 这些断言全部不碰真网络：网段枚举、候选生成、指纹解析都是纯函数 ——
 * 网络那一段（TCP 探活 + HTTP GET）在模拟器上用真服务器验（`/tmp/zv-lanscan.sh`）。
 */
class LanScanTest {

    @Test
    fun hostsForSlash24() {
        val hosts = LanScan.hostsFor("192.168.1.20", 24)
        assertEquals(253, hosts.size)                       // 1..254 去掉自己（.20）
        assertTrue(hosts.all { it.startsWith("192.168.1.") })
        assertTrue("不能扫自己（会浪费一次连接）", !hosts.contains("192.168.1.20"))
        assertTrue("不能把网络号/广播当主机", !hosts.contains("192.168.1.0") && !hosts.contains("192.168.1.255"))
    }

    @Test
    fun hostsForWideNetworkIsCapped() {
        val hosts = LanScan.hostsFor("10.0.0.5", 16)
        assertTrue("宽网段必须截断", hosts.size <= LanScan.MAX_HOSTS)
        assertTrue("先扫自己在的那个 /24", hosts.contains("10.0.0.6"))
        assertTrue(!hosts.contains("10.0.0.5"))
    }

    @Test
    fun hostsForPointToPointIsEmpty() {
        assertTrue(LanScan.hostsFor("192.168.1.20", 31).isEmpty())
        assertTrue(LanScan.hostsFor("192.168.1.20", 32).isEmpty())
        assertTrue(LanScan.hostsFor("not-an-ip", 24).isEmpty())
    }

    @Test
    fun candidatesAreHostsTimesPorts() {
        val nets = listOf(Pair("192.168.1.20", 24))
        val cands = LanScan.candidates(nets, listOf(7766, 17804), cap = 3)
        // 前三个主机 × 两个端口；端口 7766 优先
        assertEquals(6, cands.size)
        assertEquals(Pair("192.168.1.1", 7766), cands[0])
        assertEquals(Pair("192.168.1.1", 17804), cands[1])
        assertEquals(Pair("192.168.1.2", 7766), cands[2])
    }

    @Test
    fun candidatesDropBadPorts() {
        assertTrue(LanScan.candidates(listOf(Pair("10.0.0.2", 24)), listOf(0, -1, 70000)).isEmpty())
        // 重复端口只留一个
        val cands = LanScan.candidates(listOf(Pair("10.0.0.2", 24)), listOf(7766, 7766), cap = 1)
        assertEquals(1, cands.size)   // 一个主机 × 一个（去重后的）端口
    }

    @Test
    fun parseStatusAcceptsRealResponse() {
        val body = """{"data":{"needs_setup":false,"allow_register":true,"version":"0.4.9-mvp"},"meta":{},"error":null}"""
        val hit = LanScan.parseStatus("http://192.168.1.9:7766", body)
        assertNotNull(hit)
        assertEquals("http://192.168.1.9:7766", hit!!.base)
        assertEquals("0.4.9-mvp", hit.version)
        assertEquals(false, hit.needsSetup)
        assertEquals(true, hit.allowRegister)
    }

    @Test
    fun parseStatusAcceptsNeedsSetup() {
        val hit = LanScan.parseStatus("http://10.0.0.2:7766", """{"data":{"needs_setup":true,"version":"0.5.0"}}""")
        assertNotNull(hit)
        assertEquals(true, hit!!.needsSetup)
        assertEquals("0.5.0", hit.version)
    }

    @Test
    fun parseStatusRejectsOtherServers() {
        // 别的服务占着 7766：不能冒充成 zizvideo（宁可漏报）
        assertNull(LanScan.parseStatus("http://x", """{"hello":"world"}"""))
        assertNull(LanScan.parseStatus("http://x", "<html><body>nginx</body></html>"))
        assertNull(LanScan.parseStatus("http://x", """{"data":{"needs_setup":false}}"""))  // 缺 version
        assertNull(LanScan.parseStatus("http://x", """{"data":{"version":"1.0"}}"""))      // 缺 needs_setup
        assertNull(LanScan.parseStatus("http://x", ""))
    }

    /** 端口识别：用户填过/存过的端口要能被扫（反代/自定义端口部署）。 */
    @Test
    fun portParsingIsLiberal() {
        assertEquals(9000, LanScan.portOf("192.168.1.9:9000"))
        assertEquals(17804, LanScan.portOf("http://host:17804"))
        assertEquals(17804, LanScan.portOf("http://host:17804/#/feed"))
        assertEquals(7766, LanScan.portOf("192.168.1.9:7766"))
        assertEquals(0, LanScan.portOf("https://a.b"))   // 没写端口 = 默认
        assertEquals(0, LanScan.portOf("host"))
        assertEquals(0, LanScan.portOf(""))
        assertEquals(0, LanScan.portOf("http://h:99999")) // 非法端口
    }
}
