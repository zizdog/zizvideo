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
        // 裸主机名默认 http：zizvideo 自己默认就是 127.0.0.1:7766 明文，局域网也是明文；
        // 要 https 就得自己写全（顶栏会把归一化后的地址回填给用户看，不猜）。
        assertEquals("http://zv.example.com", ZvApi.normalizeBase("zv.example.com"))
        assertEquals("https://zv.example.com", ZvApi.normalizeBase("https://zv.example.com"))
    }

    @Test
    fun dropsHashAndPath() {
        assertEquals("http://192.168.1.9:7766", ZvApi.normalizeBase("http://192.168.1.9:7766/#/feed"))
        assertEquals("http://192.168.1.9:7766", ZvApi.normalizeBase("192.168.1.9:7766/app/#/favorites"))
        assertEquals("http://192.168.1.9", ZvApi.normalizeBase("  192.168.1.9/  "))
    }

    @Test
    fun rejectsGarbage() {
        assertEquals("", ZvApi.normalizeBase(""))
        assertEquals("", ZvApi.normalizeBase("   "))
    }
}
