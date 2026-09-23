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
    fun normalizeBase(raw: String): String {
        var s = raw.trim()
        if (s.isEmpty()) return ""
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        s = s.substringBefore("#")
        return try {
            val u = URL(s)
            if (u.host.isNullOrBlank()) return ""
            val port = if (u.port > 0) ":" + u.port else ""
            "${u.protocol}://${u.host}$port"
        } catch (e: Exception) {
            ""
        }
    }

    private fun request(url: String, method: String, body: String?): Reply {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8000
            readTimeout = 8000
            instanceFollowRedirects = true
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

    fun login(base: String, username: String, password: String): Reply {
        val payload = JSONObject()
            .put("username", username)
            .put("password", password)
            .toString()
        return request("$base/api/v1/auth/login", "POST", payload)
    }
}
