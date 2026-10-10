package com.zizdog.zizvideo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 原生登录灌 cookie 的门禁（P0）。
 *
 * 修之前会失败在哪：`pushCookies` 只取 `raw.substringBefore(';')` 再自己拼 `"; path=/"`，
 * 服务端 (`internal/api/middleware.go`) 刻意设的 **HttpOnly / SameSite=Strict / Secure / Max-Age
 * 全被丢掉** —— 会话 cookie 在 WebView 里变成 JS 可读（XSS 能偷会话），SameSite 的 CSRF 保护也没了，
 * 而 `internal/api/authz_test.go:130` 正在断言会话 cookie 必须 HttpOnly。
 *
 * 服务端写出来的形状（Go http.SetCookie）：
 *   `zv_session=abc; Path=/; Max-Age=604800; HttpOnly; SameSite=Strict`
 */
class CookiesTest {

    private val sessionCookie =
        "zv_session=abc123; Path=/; Max-Age=604800; HttpOnly; SameSite=Strict"

    /** 最要紧的一条：一个属性都不许丢。 */
    @Test
    fun everyAttributeSurvives() {
        val out = Cookies.forCookieManager(sessionCookie)
        assertEquals(sessionCookie, out)
        assertTrue(out!!.contains("HttpOnly"))
        assertTrue(out.contains("SameSite=Strict"))
        assertTrue(out.contains("Max-Age=604800"))
        assertTrue(out.contains("Path=/"))
        // 值本身不能被截断（原来 substringBefore(';') 之后重拼，属性全没了）
        assertTrue(out.startsWith("zv_session=abc123;"))
    }

    @Test
    fun secureAttributeIsKeptToo() {
        val secure = "zv_session=abc; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Strict"
        assertEquals(secure, Cookies.forCookieManager(secure))
        assertTrue(Cookies.forCookieManager(secure)!!.contains("Secure"))
    }

    /** CSRF cookie 不是 HttpOnly（前端要读它回填 X-CSRF-Token），这条也照原样。 */
    @Test
    fun csrfCookieKeepsItsShape() {
        val csrf = "zv_csrf=deadbeef; Path=/; Max-Age=604800; SameSite=Strict"
        assertEquals(csrf, Cookies.forCookieManager(csrf))
        assertFalse(Cookies.forCookieManager(csrf)!!.contains("HttpOnly"))
    }

    /** 不是 cookie 的串不许塞给 WebView（否则等于塞一个空 cookie）。 */
    @Test
    fun garbageIsRejected() {
        assertNull(Cookies.forCookieManager(null))
        assertNull(Cookies.forCookieManager(""))
        assertNull(Cookies.forCookieManager("   "))
        assertNull(Cookies.forCookieManager("novalue"))
        assertNull(Cookies.forCookieManager("=empty"))
        assertNull(Cookies.forCookieManager("bad name=v; Path=/"))
        assertNull(Cookies.forCookieManager("a(b)=v")) // 名字里有分隔符
    }

    /**
     * Secure + http 地址：WebView（Chromium MaybeFixUpSchemeForSecureCookie）**直接拒收**，
     * targetSdk ≥ 30 就是这样。要按属性先判出来，别等"灌完读不回来"。
     */
    @Test
    fun secureCookieOverHttpIsDetected() {
        val secure = "zv_session=abc; Path=/; Secure; HttpOnly; SameSite=Strict"
        assertTrue(Cookies.droppedBySecureOverHttp(secure, "http://192.168.1.9:7766"))
        assertTrue(Cookies.droppedBySecureOverHttp(secure, "http://192.168.1.9:7766/"))
        // https 地址没问题；不带 Secure 也没问题
        assertFalse(Cookies.droppedBySecureOverHttp(secure, "https://tv.example:8443"))
        assertFalse(Cookies.droppedBySecureOverHttp(sessionCookie, "http://192.168.1.9:7766"))
        assertFalse(Cookies.droppedBySecureOverHttp(null, "http://192.168.1.9:7766"))
        assertFalse(Cookies.droppedBySecureOverHttp("", "http://192.168.1.9:7766"))
    }

    /** 判"WebView 到底有没有会话"：只看名字匹配，别被别的 cookie 里的同名字符串骗过去。 */
    @Test
    fun sessionVisibilityLooksAtTheName() {
        assertTrue(Cookies.sessionVisible("zv_session=abc"))
        assertTrue(Cookies.sessionVisible("zv_csrf=x; zv_session=abc; other=1"))
        assertTrue(Cookies.sessionVisible(" zv_session = abc "))
        assertFalse(Cookies.sessionVisible("zv_csrf=x; other=1"))
        assertFalse(Cookies.sessionVisible("xzv_session=abc")) // 名字要完整匹配
        assertFalse(Cookies.sessionVisible("zv_session"))      // 没有 =value 就不是一条会话 cookie
        assertFalse(Cookies.sessionVisible(""))
        assertFalse(Cookies.sessionVisible(null))
    }
}
