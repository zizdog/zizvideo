package com.zizdog.zizvideo

import android.content.Context
import android.webkit.CookieManager

/**
 * 扫码登录的"确认"这一步（用户 2026-09-27）。
 *
 * 两个入口共用它：① 相机扫到码（ScanActivity）；② 用系统相机/任意扫码工具扫到码，
 * 系统把 zizvideo://qr 深链交给我们（LoginActivity 的 intent）。
 * 返回一句给用户看的话 —— 成功/失败都必须说人话，不许静默。
 */
object QrClaim {

    /** 扫到的原始内容 → 用户提示语。会阻塞（要发 HTTP），调用方自己放到后台线程。 */
    fun fromPayload(ctx: Context, payload: String): String {
        val uri = try {
            android.net.Uri.parse(payload)
        } catch (e: Exception) {
            null
        }
        if (uri == null || uri.scheme != "zizvideo" || uri.host != "qr") {
            return "这不是 zizvideo 的登录码"
        }
        val id = uri.getQueryParameter("id").orEmpty()
        val secret = uri.getQueryParameter("s").orEmpty()
        var base = try {
            android.util.Base64.decode(
                uri.getQueryParameter("u").orEmpty(),
                android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING,
            ).toString(Charsets.UTF_8)
        } catch (e: Exception) {
            ""
        }
        if (base.isBlank()) base = Prefs(ctx).baseUrl
        if (id.isBlank() || secret.isBlank() || base.isBlank()) {
            return "这个码不完整，请在电视上刷新后重扫"
        }
        val cookie = CookieManager.getInstance().getCookie(base) ?: ""
        if (!cookie.contains("zv_session=")) {
            return "手机上还没登录这台服务器（$base），先在手机上登一次再来扫"
        }
        val csrf = cookie.split("; ").firstOrNull { it.startsWith("zv_csrf=") }?.substringAfter('=') ?: ""
        val reply = try {
            ZvApi.qrClaim(base, id, secret, cookie, csrf)
        } catch (e: Exception) {
            return "连不上 $base：${e.javaClass.simpleName}"
        }
        if (reply.ok) return "已确认，电视正在进入"
        return reply.errorMessage()
    }

    /** 成功与否（给调用方决定要不要给"成功"的视觉反馈）。 */
    fun isOk(message: String) = message.startsWith("已确认")
}
