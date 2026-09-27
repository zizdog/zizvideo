package com.zizdog.zizvideo

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 首屏最容易出错的就是"地址怎么填"：带不带 http、带不带端口、粘了 `#/feed` 或尾巴斜杠。
 * 归一化必须是纯函数、可测；这是客户端唯一值得上单测的地方（其余都要真机验）。
 */
class ZvApiTest {
    @Test
    fun addsSchemeAndKeepsPort() {
        assertEquals("http://192.168.1.9:7766", ZvApi.normalizeBase("192.168.1.9:7766"))
        assertEquals("http://zv.local:7766", ZvApi.normalizeBase("http://zv.local:7766"))
        // 裸主机名默认 http（zizvideo 自己默认就是明文、局域网也是明文）。
        assertEquals("http://zv.example.com:7766", ZvApi.normalizeBase("zv.example.com"))
    }

    /** 端口规则（用户 2026-09-27 明确："端口默认 7766，可以不用输，也可以改，比如反代访问"）。 */
    @Test
    fun defaultsPortTo7766ButKeepsExplicitOnes() {
        assertEquals("http://192.168.1.9:7766", ZvApi.normalizeBase("192.168.1.9"))
        assertEquals("http://192.168.1.9:7766", ZvApi.normalizeBase("http://192.168.1.9"))
        // 自己写了就按写的走（反代常见 80/8443）
        assertEquals("http://192.168.1.9:80", ZvApi.normalizeBase("192.168.1.9:80"))
        assertEquals("http://zv.example.com:8443", ZvApi.normalizeBase("zv.example.com:8443"))
        // 勾了「使用 HTTPS」才改成 https（勾选状态由界面传进来）
        assertEquals("https://zv.example.com:8443", ZvApi.normalizeBase("zv.example.com:8443", forceTLS = true))
        // https 是反代场景：不补端口（默认 443）
        assertEquals("https://zv.example.com", ZvApi.normalizeBase("https://zv.example.com"))
    }

    @Test
    fun dropsHashAndPath() {
        assertEquals("http://192.168.1.9:7766", ZvApi.normalizeBase("http://192.168.1.9:7766/#/feed"))
        assertEquals("http://192.168.1.9:7766", ZvApi.normalizeBase("192.168.1.9:7766/app/#/favorites"))
        assertEquals("http://192.168.1.9:7766", ZvApi.normalizeBase("  192.168.1.9/  "))
    }

    @Test
    fun rejectsGarbage() {
        assertEquals("", ZvApi.normalizeBase(""))
        assertEquals("", ZvApi.normalizeBase("   "))
    }
}
