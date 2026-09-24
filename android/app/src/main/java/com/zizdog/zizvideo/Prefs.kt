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

    /**
     * 记住的口令：**只在用户勾了"记住口令"时保存**（用户 2026-09-23 要求记住与自动登录）。
     * 存在本机 SharedPreferences 里 —— 自用/自家服务器场景够用，但这是明文，界面上如实说明。
     */
    var password: String
        get() = sp.getString("password", "") ?: ""
        set(value) = sp.edit().putString("password", value).apply()

    var remember: Boolean
        get() = sp.getBoolean("remember", false)
        set(value) = sp.edit().putBoolean("remember", value).apply()

    var useTLS: Boolean
        get() = sp.getBoolean("use_tls", false)
        set(value) = sp.edit().putBoolean("use_tls", value).apply()
}
