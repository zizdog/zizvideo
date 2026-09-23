package com.zizdog.zizvideo

import android.content.Context

/**
 * 只记服务器地址与用户名：口令**不落盘**（服务器本来就发会话 cookie，没必要存密码）。
 * cookie 由 WebView 的 CookieManager 持久化，重启后免登录。
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("zv", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = sp.getString("base_url", "") ?: ""
        set(value) = sp.edit().putString("base_url", value).apply()

    var username: String
        get() = sp.getString("username", "") ?: ""
        set(value) = sp.edit().putString("username", value).apply()
}
