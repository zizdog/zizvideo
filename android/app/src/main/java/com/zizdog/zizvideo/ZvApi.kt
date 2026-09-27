package com.zizdog.zizvideo

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 服务器交互：地址规范化 + 探活 + 登录。故意只用 HttpURLConnection —— 少一个依赖少一份构建风险。
 * 对外契约见 zizvideo 仓库 CONTRACT.md：公开端点只有 /healthz 与 /api/v1/setup/status。
 */
object ZvApi {

    class Reply(val status: Int, val body: String, val cookies: List<String>) {
        val ok: Boolean get() = status in 200..299

        fun data(): JSONObject? = try {
            JSONObject(body).optJSONObject("data")
        } catch (e: Exception) {
            null
        }

        /** 服务器的人话错误（信封里的 error.message），没有就退回 HTTP 码。 */
        fun errorMessage(): String {
            val msg = try {
                JSONObject(body).optJSONObject("error")?.optString("message") ?: ""
            } catch (e: Exception) {
                ""
            }
            return if (msg.isNotBlank()) msg else "HTTP $status"
        }
    }

    /** 把用户输入变成 base：补 scheme、砍掉 #/path 与多余的路径尾巴、去尾斜杠。 */
    fun normalizeBase(raw: String, forceTLS: Boolean = false): String {
        var s = raw.trim()
        if (s.isEmpty()) return ""
        // 勾了"使用 HTTPS"就按 https 走（用户 2026-09-23：登录界面支持选择 SSL，不用自己敲 scheme）
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = if (forceTLS) "https://$s" else "http://$s"
        s = s.substringBefore("#")
        return try {
            val u = URL(s)
            if (u.host.isNullOrBlank()) return ""
            // 端口默认 7766（用户 2026-09-27："端口默认 7766 单独输入，可以不用输也可以改，比如反代访问"）：
            //   · 自己写了端口 ⇒ 用写的（反代想走 80/8443 就写出来）
            //   · 没写 + http ⇒ 补 :7766（zizvideo 的默认端口）
            //   · 没写 + https ⇒ 不补（反代/证书场景走 443 默认）
            val port = when {
                u.port > 0 -> ":" + u.port
                u.protocol == "http" -> ":7766"
                else -> ""
            }
            "${u.protocol}://${u.host}$port"
        } catch (e: Exception) {
            ""
        }
    }

    private fun request(url: String, method: String, body: String?, cookie: String = "", csrf: String = ""): Reply {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8000
            readTimeout = 8000
            instanceFollowRedirects = true
            // 带上 UA：有的反代会拦没有 UA 的请求（浏览器能过、App 过不去的那类），
            // 服务端日志里也能一眼认出是 App（用户 2026-09-27："浏览器能登，TV 端不行"）。
            setRequestProperty("User-Agent", "zizvideo-android")
            if (cookie.isNotBlank()) setRequestProperty("Cookie", cookie)
            if (csrf.isNotBlank()) setRequestProperty("X-CSRF-Token", csrf)
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            // Set-Cookie 的 key 大小写随实现变，别写死。
            val cookies = conn.headerFields.entries
                .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                .flatMap { it.value ?: emptyList() }
            return Reply(status, text, cookies)
        } finally {
            conn.disconnect()
        }
    }

    /** 探活 + 拿版本与"是否还没初始化"（地址填错时这里就会失败，登录前先拦一道）。 */
    fun setupStatus(base: String): Reply = request("$base/api/v1/setup/status", "GET", null)

    /** 带会话 cookie 的 GET：原生侧复用网页端已有的列表接口，不另立契约。 */
    fun get(url: String, cookie: String): Reply = request(url, "GET", null, cookie)

    /** 写操作：会话 cookie + X-CSRF-Token（与网页端同一套双提交）。 */
    fun patch(url: String, body: String, cookie: String, csrf: String): Reply = request(url, "PATCH", body, cookie, csrf)

    /** 通用读写（POST/DELETE 等），同样带 cookie + CSRF。 */
    fun send(url: String, method: String, body: String?, cookie: String, csrf: String): Reply =
        request(url, method, body, cookie, csrf)

    /** 扫码登录：手机替电视确认（要带本机已有会话的 cookie + CSRF）。 */
    fun qrClaim(base: String, id: String, secret: String, cookie: String, csrf: String): Reply {
        val payload = JSONObject()
            .put("id", id)
            .put("secret", secret)
            .put("base", base)
            .toString()
        return request("$base/api/v1/auth/qr/claim", "POST", payload, cookie, csrf)
    }

    fun login(base: String, username: String, password: String): Reply {
        val payload = JSONObject()
            .put("username", username)
            .put("password", password)
            .toString()
        return request("$base/api/v1/auth/login", "POST", payload)
    }
}
