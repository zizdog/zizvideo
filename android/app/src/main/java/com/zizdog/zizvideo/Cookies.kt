package com.zizdog.zizvideo

/**
 * 原生登录把服务端 Set-Cookie 灌进 WebView 的规矩。
 *
 * 原来的做法是 `raw.substringBefore(';') + "; path=/"` —— 服务端刻意设的
 * **HttpOnly / SameSite=Strict / Secure / Max-Age 全丢**：会话 cookie 在 WebView 里变成 JS 可读
 * （XSS 就能偷会话）、SameSite 的 CSRF 保护没了，`internal/api/authz_test.go` 断言的 HttpOnly 白设。
 * 现在的规矩：**整串原样**交给 `CookieManager.setCookie`（Chromium 的 setCookie 收的就是
 * Set-Cookie 头那种格式，属性它自己解析），这里只做"这串到底是不是一条 cookie"的校验。
 */
object Cookies {

    /** 服务端会话 cookie 名（与 `internal/api` 的 CookieSession 一致）。 */
    const val SESSION_NAME = "zv_session"

    /**
     * 从一条 Set-Cookie 串构造出要交给 `CookieManager.setCookie` 的值。
     * 返回 null = 这串不能用（空 / 没有 name=value / name 不是合法 token），调用方跳过它。
     * 属性一个字符都不动，HttpOnly / SameSite / Secure / Max-Age 原样留着。
     */
    fun forCookieManager(raw: String?): String? {
        val t = raw?.trim().orEmpty()
        if (t.isEmpty()) return null
        val pair = t.substringBefore(';').trim()
        val eq = pair.indexOf('=')
        if (eq <= 0) return null
        if (!isToken(pair.substring(0, eq).trim())) return null
        return t
    }

    /**
     * 这条 cookie 会不会被 WebView 丢掉：带 `Secure` 属性、而地址是 `http://`。
     * 依据是 WebView 自己的实现（Chromium `MaybeFixUpSchemeForSecureCookie`）：targetSdk ≥ 30
     * 时"往 http 地址写 Secure cookie"直接**拒收**（Android R+ 的 strict secure cookie 策略）。
     * 原来靠"灌完再读回来"才发现，这里按属性**先判**一次，错误提示能说到点子上。
     */
    fun droppedBySecureOverHttp(setCookie: String?, base: String?): Boolean {
        val c = forCookieManager(setCookie) ?: return false
        if (!hasAttribute(c, "secure")) return false
        return base?.trim()?.startsWith("http://") == true
    }

    /** Cookie 请求头里有没有会话 cookie（服务端会话 cookie 是 HttpOnly，WebView 读得回来，见 GetCookie）。 */
    fun sessionVisible(cookieHeader: String?): Boolean {
        val header = cookieHeader ?: return false
        return header.split(';').any {
            val seg = it.trim()
            seg.contains('=') && seg.substringBefore('=').trim() == SESSION_NAME
        }
    }

    /** RFC 6265 的 token：name 里出现分隔符/控制字符/空格就不是合法 cookie 名。 */
    private fun isToken(s: String): Boolean {
        if (s.isEmpty()) return false
        val bad = "()<>@,;:\\\"/[]?={} \t"
        return s.all { it.code in 0x21..0x7e && bad.indexOf(it) < 0 }
    }

    /** 属性段（第一个 `;` 之后）里有没有这个属性名（大小写不敏感）。 */
    private fun hasAttribute(cookie: String, name: String): Boolean =
        cookie.split(';').drop(1).any {
            it.trim().substringBefore('=').trim().equals(name, ignoreCase = true)
        }
}
