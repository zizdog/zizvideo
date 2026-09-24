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
    private lateinit var splash: View
    private lateinit var tlsBox: android.widget.CheckBox
    private lateinit var rememberBox: android.widget.CheckBox

    /** 快捷方式要求直接开播的队列（zizvideo://listen/feed ⇒ "feed"）。 */
    private var listenKind = ""

    /** zizvideo://upload：进网页上传页后直接弹系统选择器。 */
    private var pickUploads = false

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
        splash = findViewById(R.id.splash)

        tlsBox = findViewById(R.id.tls)
        rememberBox = findViewById(R.id.remember)
        server.setText(prefs.baseUrl)
        username.setText(prefs.username)
        tlsBox.isChecked = prefs.useTLS
        rememberBox.isChecked = prefs.remember
        login.setOnClickListener { submit() }

        // 一键申请"电池不优化"：国产 ROM 后台被杀的头号原因，让用户少翻一层系统设置。
        // 只在还没放行时显示；放行了就不显示（不占地方、不误导）。
        val battery = findViewById<MaterialButton>(R.id.battery)
        val pm = getSystemService(android.os.PowerManager::class.java)
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
            battery.visibility = View.VISIBLE
            battery.setOnClickListener {
                try {
                    @Suppress("BatteryLife")
                    startActivity(
                        Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                            .setData(android.net.Uri.parse("package:$packageName")),
                    )
                } catch (e: Exception) {
                    status.text = "这台机器不支持一键申请，请到系统设置里手动允许"
                }
            }
        }

        val data = intent?.data?.toString() ?: ""
        if (data.startsWith("zizvideo://listen/")) listenKind = data.removePrefix("zizvideo://listen/")
        // zizvideo://upload：快捷方式直接进上传页并弹系统选择器（后台传、息屏不断）
        if (data.startsWith("zizvideo://upload")) pickUploads = true
        // ⚠️ 顺序很重要：必须等 `login` 的点击监听器和 intent（listenKind/pickUploads）都就绪，
        //    再来决定"怎么进" —— 否则 performClick() 没监听器（等于没点）、或 enterWeb 时 listenKind 还是空的
        //    （实测：把这两句放在上面，就变成"记住了口令也不会自动登录"）。
        val silent = silentEntryIfPossible()
        if (!silent && prefs.remember && prefs.password.isNotBlank()) {
            login.performClick()
        }
        // 静默通道已经处理过了；这里只保证遮罩不会卡在屏幕上
        autoEnterIfLoggedIn()
    }

    /**
     * 有 cookie 就静默验证一次：
     *   · 会话还有效 ⇒ 直接进观看页（登录界面从头到尾不显示）；
     *   · 已过期 ⇒ 收起遮罩，露出登录表单（这时才需要用户输口令）。
     * 返回 true 表示"已经在处理了，别再走下面那套自动登录"。
     */
    private fun silentEntryIfPossible(): Boolean {
        val base = prefs.baseUrl
        if (base.isBlank()) return false
        val cookie = CookieManager.getInstance().getCookie(base) ?: ""
        if (cookie.isBlank()) return false
        splash.visibility = View.VISIBLE
        android.util.Log.i("zv-login", "silent probe base=" + base)
        Thread {
            val me = try {
                ZvApi.get("$base/api/v1/auth/me", cookie)
            } catch (e: Exception) {
                null
            }
            runOnUiThread {
                if (me != null && me.ok) enterWeb(base, "")
                else {
                    // 会话过期：记过口令就**直接自动登录**（用户要"打开就进"，不是再点一次登录）；
                    // 没记口令才露表单。
                    splash.visibility = View.GONE
                    if (prefs.remember && prefs.password.isNotBlank()) {
                        android.util.Log.i("zv-login", "session expired → auto login with saved password")
                        login.performClick()
                    } else {
                        android.util.Log.i("zv-login", "form shown（会话过期且没记口令）")
                    }
                }
            }
        }.start()
        return true
    }

    private fun autoEnterIfLoggedIn() {
        // 静默通道已经处理过了（含"过期就露表单"），这里只负责别让遮罩卡住
        splash.visibility = View.GONE
    }

    private fun submit() {
        val base = ZvApi.normalizeBase(server.text?.toString() ?: "", tlsBox.isChecked)
        if (base.isEmpty()) {
            status.text = getString(R.string.err_server_empty)
            return
        }
        val user = username.text?.toString()?.trim() ?: ""
        var pass = password.text?.toString() ?: ""
        if (pass.isEmpty() && rememberBox.isChecked) pass = prefs.password // 自动登录时用记住的口令
        if (user.isEmpty() || pass.isEmpty()) {
            status.text = getString(R.string.err_credentials_empty)
            return
        }
        // 记住地址/用户名/TLS；口令只在勾选时落盘（界面上写明是明文）
        prefs.baseUrl = base
        prefs.username = user
        prefs.useTLS = tlsBox.isChecked
        prefs.remember = rememberBox.isChecked
        prefs.password = if (rememberBox.isChecked) pass else ""
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

    private fun fail(message: String) {
        android.util.Log.w("zv-login", "login failed: " + message)
        setBusy(false, message)
    }

    private fun enterWeb(base: String, note: String) {
        setBusy(false, note)
        if (listenKind.isNotBlank()) {
            // 快捷方式"听首页"：直接起原生播放器（队列由 GET /feed/next 拉），不用先进网页
            startActivity(
                Intent(this, PlayerActivity::class.java)
                    .putExtra(PlayerActivity.EXTRA_KIND, listenKind),
            )
            finish()
            return
        }
        val intent = Intent(this, WebActivity::class.java).putExtra(WebActivity.EXTRA_BASE, base)
        // 允许"启动就打开某一页"（通知/深链/自测都靠它，别在测试里写死坐标点导航栏）
        val explicitPath = this.intent.getStringExtra(WebActivity.EXTRA_PATH)
        if (pickUploads) {
            intent.putExtra(WebActivity.EXTRA_PATH, "/#/upload")
            intent.putExtra(WebActivity.EXTRA_PICK, true)
        } else if (explicitPath != null) {
            intent.putExtra(WebActivity.EXTRA_PATH, explicitPath)
        }
        startActivity(intent)
        finish()
    }
}
