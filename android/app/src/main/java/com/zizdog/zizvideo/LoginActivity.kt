package com.zizdog.zizvideo

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText

/**
 * 首屏（用户 2026-09-23 要求）：服务器地址 + 用户名 + 口令。
 * 流程：探活（setup/status，顺便拿版本号）→ 登录 → 会话 cookie 灌进 WebView 的 CookieManager → 进网页界面。
 * 还没初始化（needs_setup）时直接进网页走初始化向导 —— 那种情况下还没有账号可登。
 */
class LoginActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var server: TextInputEditText
    private lateinit var username: TextInputEditText
    private lateinit var password: TextInputEditText
    private lateinit var login: MaterialButton
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        Ui.padSystemBars(findViewById(R.id.loginRoot))
        prefs = Prefs(this)
        server = findViewById(R.id.server)
        username = findViewById(R.id.username)
        password = findViewById(R.id.password)
        login = findViewById(R.id.login)
        status = findViewById(R.id.status)

        server.setText(prefs.baseUrl)
        username.setText(prefs.username)
        login.setOnClickListener { submit() }
    }

    private fun submit() {
        val base = ZvApi.normalizeBase(server.text?.toString() ?: "")
        if (base.isEmpty()) {
            status.text = getString(R.string.err_server_empty)
            return
        }
        val user = username.text?.toString()?.trim() ?: ""
        val pass = password.text?.toString() ?: ""
        if (user.isEmpty() || pass.isEmpty()) {
            status.text = getString(R.string.err_credentials_empty)
            return
        }
        // 记住地址与用户名（口令不落盘）
        prefs.baseUrl = base
        prefs.username = user
        server.setText(base)

        setBusy(true, getString(R.string.action_checking))
        Thread {
            val probe = try {
                ZvApi.setupStatus(base)
            } catch (e: Exception) {
                fail("连不上 $base：${e.javaClass.simpleName}")
                return@Thread
            }
            if (!probe.ok) {
                fail("这地址不是 zizvideo（${probe.errorMessage()}）")
                return@Thread
            }
            val info = probe.data()
            val version = info?.optString("version") ?: ""
            if (info?.optBoolean("needs_setup") == true) {
                // 还没建管理员：直接进网页做初始化，别在这儿卡着
                runOnUiThread { enterWeb(base, "首次使用，请在网页里创建管理员") }
                return@Thread
            }
            val reply = try {
                ZvApi.login(base, user, pass)
            } catch (e: Exception) {
                fail("登录请求失败：${e.javaClass.simpleName}")
                return@Thread
            }
            if (!reply.ok) {
                fail(reply.errorMessage())
                return@Thread
            }
            pushCookies(base, reply.cookies)
            val name = reply.data()?.optString("display_name")?.ifBlank { user } ?: user
            runOnUiThread { enterWeb(base, "已连接 zizvideo $version · $name") }
        }.start()
    }

    /** 把登录响应的 Set-Cookie 灌进 WebView 的 cookie 存储；不灌的话网页那一侧还是未登录。 */
    private fun pushCookies(base: String, cookies: List<String>) {
        val manager = CookieManager.getInstance()
        manager.setAcceptCookie(true)
        for (raw in cookies) {
            val pair = raw.substringBefore(';').trim()
            if (pair.isEmpty()) continue
            manager.setCookie(base, "$pair; path=/")
        }
        manager.flush()
    }

    private fun setBusy(busy: Boolean, note: String) {
        runOnUiThread {
            login.isEnabled = !busy
            login.text = if (busy) getString(R.string.action_checking) else getString(R.string.action_login)
            status.visibility = if (note.isEmpty()) View.GONE else View.VISIBLE
            status.text = note
        }
    }

    private fun fail(message: String) = setBusy(false, message)

    private fun enterWeb(base: String, note: String) {
        setBusy(false, note)
        startActivity(Intent(this, WebActivity::class.java).putExtra(WebActivity.EXTRA_BASE, base))
        finish()
    }
}
