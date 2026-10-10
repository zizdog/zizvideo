package com.zizdog.zizvideo

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
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
    private lateinit var loginScroll: android.widget.ScrollView
    private lateinit var tlsBox: android.widget.CheckBox
    private lateinit var rememberBox: android.widget.CheckBox

    /** 局域网自动探测那块（用户 2026-09-28）：状态行 / 结果列表 / 重新搜索。 */
    private lateinit var scanStatus: TextView
    private lateinit var scanList: android.widget.LinearLayout
    private lateinit var scanBtn: com.google.android.material.button.MaterialButton

    /** 这一次启动是否已经有结论（进网页了 / 该露表单了）—— 给遮罩看门狗用。 */
    private var settled = false

    /** 一次只跑一个登录请求（电视键盘的"确认"键可能同时送 editor action 和回车）。 */
    private var submitting = false

    /** 这一轮登录到底发给了谁（失败提示里带上，用户一眼看得出地址/用户名是不是打错了）。 */
    private var lastTarget = ""

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
        loginScroll = findViewById(R.id.loginScroll)

        tlsBox = findViewById(R.id.tls)
        rememberBox = findViewById(R.id.remember)
        scanStatus = findViewById(R.id.scanStatus)
        scanList = findViewById(R.id.scanList)
        scanBtn = findViewById(R.id.scanBtn)
        scanBtn.setOnClickListener { startScan() }
        server.setText(prefs.baseUrl)
        username.setText(prefs.username)
        tlsBox.isChecked = prefs.useTLS
        rememberBox.isChecked = prefs.remember
        login.setOnClickListener { submit() }
        wireImeChain()

        // 扫码登录（用户 2026-09-27）：只有电视端才显示 —— 手机上"用手机扫手机上显示的码"没意义
        // （手机端要扫的话在「我的 → 扫码登录电视」里，那是相机入口）。
        // 放在焦点链末尾：隐藏它不会让上面任何一跳卡住（登录页踩过这个坑）。
        val qr = findViewById<MaterialButton>(R.id.qrlogin)
        if (!WebActivity.isTv(this)) {
            // 手机上这颗按钮 = **直接用相机扫电视上的码**（原生入口，不依赖服务端把网页前端更新到新版）
            qr.text = getString(R.string.action_qr_scan_phone)
            qr.setOnClickListener {
                try {
                    startActivity(Intent(this, ScanActivity::class.java))
                } catch (e: Exception) {
                    showError("打不开扫码页：" + e.javaClass.simpleName)
                }
            }
        } else {
            qr.setOnClickListener {
                val base = ZvApi.normalizeBase(server.text?.toString() ?: "", tlsBox.isChecked)
                if (base.isEmpty()) {
                    showError(getString(R.string.err_server_empty))
                    return@setOnClickListener
                }
                prefs.baseUrl = base
                server.setText(base)
                // 不 finish：用户在二维码页按返回能回到这个表单接着手输
                startActivity(
                    Intent(this, WebActivity::class.java)
                        .putExtra(WebActivity.EXTRA_BASE, base)
                        .putExtra(WebActivity.EXTRA_PATH, "/#/qrlogin"),
                )
            }
        }

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
        // 扫码登录的深链（系统相机/任意扫码工具扫到电视上的码，系统把 zizvideo://qr 交给我们）：
        // 本机已有会话就直接替电视确认，然后照常进网页；没登录就说清楚要先去手机端登录。
        if (data.startsWith("zizvideo://qr")) {
            claimQrFromLink(data)
            return
        }
        // 快捷方式"扫码登录电视"：直接开相机（原生入口，和服务端前端版本无关）
        if (data.startsWith("zizvideo://qrscan")) {
            startActivity(Intent(this, ScanActivity::class.java))
            finish()
            return
        }
        if (data.startsWith("zizvideo://listen/")) listenKind = data.removePrefix("zizvideo://listen/")
        // zizvideo://upload：快捷方式直接进上传页并弹系统选择器（后台传、息屏不断）
        if (data.startsWith("zizvideo://upload")) pickUploads = true
        // ⚠️ 顺序很重要：必须等 `login` 的点击监听器和 intent（listenKind/pickUploads）都就绪，
        //    再来决定"怎么进" —— 否则 performClick() 没监听器（等于没点）、或 enterWeb 时 listenKind 还是空的
        //    （实测：把这两句放在上面，就变成"记住了口令也不会自动登录"）。
        // 启动路线（用户 2026-09-25："每次打开都明显看到登录信息，应该只显示 logo，登录成功直接进播放"）：
        //   · 有会话 cookie，或记住了口令 ⇒ **全程盖着只显示 logo 的遮罩**，成功就进播放；
        //   · 两样都没有（首次使用/没勾记住）⇒ 才收遮罩露表单。
        // 关键：遮罩只由"决定露表单"（showForm）或"登录失败"（fail）来收 ——
        // 原来那句 autoEnterIfLoggedIn() 是无条件收遮罩，于是走"用记住的口令自动登录"那一秒里
        // 表单是露着的，正是用户看到的那一下。
        val cookie = if (prefs.baseUrl.isBlank()) "" else
            (CookieManager.getInstance().getCookie(prefs.baseUrl) ?: "")
        val canSilent = prefs.baseUrl.isNotBlank() &&
            (cookie.isNotBlank() || (prefs.remember && prefs.password.isNotBlank()))
        // 网页侧把我们退回来了（它自己的会话校验没过）：**必须当场把原因说清**，
        // 而且**不许再自动登录** —— 否则就是"闪一下又回到登录页"的死循环（用户 2026-09-27 报障）。
        val bounce = intent?.getStringExtra(WebActivity.EXTRA_NOTE).orEmpty()
        if (bounce.isNotBlank()) {
            android.util.Log.w("zv-login", "web bounced: " + bounce)
            showForm(bounce)
            showError(bounce)
        } else if (canSilent) {
            splash.visibility = View.VISIBLE
            armSplashWatchdog()
            silentEntryIfPossible()
        } else {
            showForm("")
        }
    }

    /**
     * 失败原因必须"看得见"（用户 2026-09-27 报障："闪一下又回到登录页，即没成功，也没提示为什么失败"）。
     * 光写页面底部那行小字不够 —— 电视上它正好被浮动软键盘盖住，等于没说。所以三管齐下：
     * 状态行 + 气泡（Toast，浮在最上层，不受键盘/滚动影响）+ 日志。
     */
    private fun showError(message: String) {
        if (message.isBlank()) return
        status.visibility = View.VISIBLE
        status.text = message
        try {
            android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            android.util.Log.w("zv-login", "toast failed: " + e.javaClass.simpleName)
        }
        try {
            loginScroll.post { loginScroll.smoothScrollTo(0, status.bottom) }
        } catch (e: Exception) {
            /* 忽略：滚动只是锦上添花 */
        }
    }

    /**
     * 电视端遥控器兜底（用户 2026-09-25 报障："登录界面确认按钮无法获得焦点，输入完信息无法操作登录"）：
     * 有些电视盒子/输入法把"确认"合成成**回车**塞给 Activity（不走 editor action），
     * 输入框收到回车只会把焦点顺移走（实测：口令框 → 使用 HTTPS，登录请求根本没发生）。
     * 所以这里统一成表单语义：地址/用户名 ⇒ 下一个输入框，口令 ⇒ 直接登录。
     * 只认回车 —— 遥控器的"确定"键在输入框上是"打开键盘"，不能抢。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN &&
            (event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER)
        ) {
            when (currentFocus) {
                server -> { username.requestFocus(); return true }
                username -> { password.requestFocus(); return true }
                password -> { submit(); return true }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /**
     * 电视端遥控器（用户 2026-09-25 报障："登录界面确认按钮无法获得焦点，输入完信息无法操作登录"）：
     * 电视的软键盘是遥控器驱动的 —— 键盘上那颗"下一项/完成"键由 `imeOptions` 决定**有没有**，
     * 光在 XML 里写 imeOptions 还不够，action 得自己接住：地址/用户名 ⇒ 跳下一个输入框，口令 ⇒ 直接登录。
     * 这样"输入完"之后键盘上永远有一条能走到登录的路（遥控器不用先按返回收键盘再摸黑找按钮）。
     */
    private fun wireImeChain() {
        server.setOnEditorActionListener { _, actionId, _ -> focusOnIme(actionId, username) }
        username.setOnEditorActionListener { _, actionId, _ -> focusOnIme(actionId, password) }
        password.setOnEditorActionListener { _, actionId, _ -> submitOnIme(actionId) }
    }

    private fun focusOnIme(actionId: Int, next: View): Boolean {
        // IME_NULL：硬件回车（遥控器/外接键盘）—— 也当成"下一项"，别让回车什么都不做
        if (actionId == EditorInfo.IME_ACTION_NEXT || actionId == EditorInfo.IME_ACTION_DONE ||
            actionId == EditorInfo.IME_NULL
        ) {
            next.requestFocus()
            return true
        }
        return false
    }

    private fun submitOnIme(actionId: Int): Boolean {
        if (actionId == EditorInfo.IME_ACTION_DONE || actionId == EditorInfo.IME_ACTION_GO ||
            actionId == EditorInfo.IME_ACTION_SEND || actionId == EditorInfo.IME_NULL
        ) {
            submit()
            return true
        }
        return false
    }

    /** 深链扫码：拿本机会话替电视确认（QrClaim 里解析深链 + 发请求）。 */
    private fun claimQrFromLink(payload: String) {
        splash.visibility = View.VISIBLE
        setBusy(true, getString(R.string.action_qr_checking))
        armSplashWatchdog()
        Thread {
            val message = QrClaim.fromPayload(this, payload)
            val ok = QrClaim.isOk(message)
            runOnUiThread {
                settled = true
                android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show()
                val base = prefs.baseUrl
                if (ok && base.isNotBlank()) {
                    enterWeb(base, message)
                } else {
                    showForm(message)
                    setBusy(false, message)
                    showError(message)
                }
            }
        }.start()
    }

    /** 遮罩看门狗：万一探活/登录卡住，10 秒后也要把表单露出来（不能把用户锁在 logo 上）。 */
    private fun armSplashWatchdog() {
        splash.postDelayed({
            if (!settled) {
                android.util.Log.w("zv-login", "splash watchdog fired")
                fail(getString(R.string.err_login_timeout))
            }
        }, 10000)
    }

    /** 收起软键盘（电视端是浮层，不收会盖住进度/错误提示）。 */
    private fun hideIme() {
        try {
            val imm = getSystemService(android.view.inputmethod.InputMethodManager::class.java)
            imm?.hideSoftInputFromWindow(currentFocus?.windowToken ?: server.windowToken, 0)
        } catch (e: Exception) {
            android.util.Log.w("zv-login", "hideIme: " + e.javaClass.simpleName)
        }
    }

    /** 收起遮罩、露出登录表单（只在"必须用户自己输"时才调用）。 */
    private fun showForm(note: String) {
        settled = true
        // 落日志：验收脚本靠它判断"这次启动到底有没有露表单"（用户报的就是不该露的时候露了）
        android.util.Log.i("zv-login", "form shown（" + (if (note.isEmpty()) "首次/no-cred" else note) + "）")
        splash.visibility = View.GONE
        status.visibility = if (note.isEmpty()) View.GONE else View.VISIBLE
        status.text = note
        // 首次使用（地址没存过、也没手输）⇒ 自动扫一遍局域网，用户只需在结果里选一台
        if (prefs.baseUrl.isBlank() && (server.text?.toString() ?: "").isBlank()) startScan()
    }

    /* ---------------- 局域网自动探测（用户 2026-09-28） ---------------- */

    /** 正在扫的那一轮；重新扫/离开页面时置真让它尽快收工。 */
    private var scanCancel: java.util.concurrent.atomic.AtomicBoolean? = null
    private var scanning = false

    /**
     * 扫局域网并列出找到的服务器。端口取「默认 7766 + 用户已填/已存的端口」——
     * 这样反代/自定义端口的部署（例如开发机的 17804）也能被搜到，而不是只认 7766。
     */
    private fun startScan() {
        if (scanning) return
        scanning = true
        scanCancel?.set(true)
        val cancel = java.util.concurrent.atomic.AtomicBoolean(false)
        scanCancel = cancel
        scanList.removeAllViews()
        scanStatus.text = getString(R.string.scan_running)
        scanBtn.isEnabled = false
        val ports = ArrayList<Int>()
        ports.add(LanScan.DEFAULT_PORT)
        for (raw in listOf(server.text?.toString() ?: "", prefs.baseUrl)) {
            val port = LanScan.portOf(raw)
            if (port > 0 && !ports.contains(port)) ports.add(port)
        }
        android.util.Log.i("zv-login", "lan scan start ports=" + ports.joinToString(","))
        Thread {
            val found = LanScan.scan(ports, cancel = cancel) { hit ->
                runOnUiThread { if (!cancel.get()) addScanRow(hit) }
            }
            runOnUiThread {
                if (cancel.get() || isFinishing || isDestroyed) return@runOnUiThread
                scanning = false
                scanBtn.isEnabled = true
                when {
                    found.isEmpty() -> scanStatus.text = getString(R.string.scan_none)
                    found.size == 1 -> {
                        // 只有一台就**直接填好**（用户要的就是"只剩用户名密码要输"）
                        scanStatus.text = getString(R.string.scan_found_one, found[0].base)
                        pickServer(found[0])
                    }
                    else -> scanStatus.text = getString(R.string.scan_found_many, found.size)
                }
            }
        }.start()
    }

    /** 一台服务器一颗按钮：遥控器上下走到它、按确定即选中（焦点链接回地址框/用户名）。 */
    private fun addScanRow(hit: LanScan.Found) {
        if (isFinishing || isDestroyed) return
        val label = hit.base +
            (if (hit.version.isNotBlank()) "　·　v" + hit.version else "") +
            (if (hit.needsSetup) "　·　未初始化" else "")
        val row = com.google.android.material.button.MaterialButton(this).apply {
            id = View.generateViewId()
            text = label
            isAllCaps = false
            textSize = 14f
            setOnClickListener { pickServer(hit) }
            nextFocusDownId = R.id.server
            nextFocusForwardId = R.id.server
        }
        scanList.addView(row)
        wireScanFocus()
    }

    /**
     * 结果列表的焦点链：↑↓ 在结果**之间**走，最后一台再往下才回到地址框。
     * （遥控器只有上下左右 + 确定：不给这条链，↓ 会直接从第一台跳回地址框，第二台永远选不到 ——
     *  实测就是这样，验收里"遥控器选中第二台"那条一直是红的。）
     */
    private fun wireScanFocus() {
        val rows = (0 until scanList.childCount).map { scanList.getChildAt(it) }
        for ((i, row) in rows.withIndex()) {
            row.nextFocusUpId = if (i > 0) rows[i - 1].id else R.id.scanBtn
            row.nextFocusDownId = if (i < rows.size - 1) rows[i + 1].id else R.id.server
        }
        server.nextFocusUpId = if (rows.isNotEmpty()) rows.last().id else R.id.scanList
    }

    /** 选中一台：地址填好、记住它，焦点直接落到用户名 —— 用户只剩用户名/口令要输。 */
    private fun pickServer(hit: LanScan.Found) {
        prefs.baseUrl = hit.base
        prefs.useTLS = hit.base.startsWith("https://")
        server.setText(hit.base)
        tlsBox.isChecked = prefs.useTLS
        username.requestFocus()
        android.util.Log.i("zv-login", "lan scan picked " + hit.base + " v" + hit.version)
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
        if (cookie.isBlank()) {
            // 没有 cookie，但记住了口令 ⇒ 直接用口令登（遮罩保持显示，用户看不到表单）
            if (prefs.remember && prefs.password.isNotBlank()) {
                android.util.Log.i("zv-login", "no cookie → auto login with saved password（遮罩保持）")
                login.performClick()
                return true
            }
            return false
        }
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
                else if (prefs.remember && prefs.password.isNotBlank()) {
                    // 会话过期：记过口令就直接自动登录（用户要"打开就进"，不是再点一次登录）——
                    // 遮罩**不收**，全程只有 logo。
                    android.util.Log.i("zv-login", "session expired → auto login with saved password")
                    login.performClick()
                } else {
                    android.util.Log.i("zv-login", "form shown（会话过期且没记口令）")
                    showForm(getString(R.string.err_session_expired))
                    showError(getString(R.string.err_session_expired))
                }
            }
        }.start()
        return true
    }

    private fun submit() {
        // 一次只跑一个：电视键盘的"确认"键既会送 editor action，有的盒子还会再补一个回车
        // （dispatchKeyEvent 那条兜底），两次登录请求叠着发会互相打架。
        if (submitting) return
        val base = ZvApi.normalizeBase(server.text?.toString() ?: "", tlsBox.isChecked)
        if (base.isEmpty()) {
            showError(getString(R.string.err_server_empty))
            return
        }
        val user = username.text?.toString()?.trim() ?: ""
        var pass = password.text?.toString() ?: ""
        if (pass.isEmpty() && rememberBox.isChecked) pass = prefs.password // 自动登录时用记住的口令
        if (user.isEmpty() || pass.isEmpty()) {
            showError(getString(R.string.err_credentials_empty))
            return
        }
        // 记住地址/用户名/TLS；口令只在勾选时落盘（界面上写明是明文）
        prefs.baseUrl = base
        prefs.username = user
        prefs.useTLS = tlsBox.isChecked
        prefs.remember = rememberBox.isChecked
        prefs.password = if (rememberBox.isChecked) pass else ""
        server.setText(base)
        // 失败提示里带上"发给了谁"：电视键盘打错的地址/多打的空格，一眼就能看出来
        // （用户 2026-09-27：浏览器同样账号能登，App 不行 —— 得让提示自己说清是发给谁）
        lastTarget = user + "@" + base

        runOnUiThread { splash.visibility = View.VISIBLE }
        // 电视上的软键盘是浮在表单上的小窗，不主动收起来就会一直盖着"正在检查…"（用户报障那一屏就是它）
        hideIme()
        armSplashWatchdog()
        submitting = true
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
                // 401 在老版本服务端上回的是"未登录或会话已过期"（那句话是给网页会话过期用的），
                // 用户根本看不出是自己口令打错了 —— 登录这一步统一翻译成人话（用户 2026-09-27 报障）。
                val raw = reply.errorMessage()
                val msg = if (reply.status == 401 && !raw.contains("口令") && !raw.contains("密码")) {
                    getString(R.string.err_bad_credentials)
                } else {
                    raw
                }
                fail(msg)
                return@Thread
            }
            pushCookies(base, reply.cookies)
            // "登录请求成功"不等于"网页也登录上了"：cookie 带 Secure 而地址是 http 时，
            // WebView 会**拒收**这个 cookie（原生这边发的是裸 Cookie 头，所以看着一切正常），
            // 然后网页发现没会话就退到 #/login，用户看到的就是"闪一下又回到登录页、还没提示"。
            // Android R+ 的 strict secure cookie 策略就是这样（Chromium MaybeFixUpSchemeForSecureCookie），
            // 所以这里按属性先判一次（用户 2026-09-27 报障）。
            val rejected = reply.cookies.any { Cookies.droppedBySecureOverHttp(it, base) }
            val webCookie = CookieManager.getInstance().getCookie(base) ?: ""
            android.util.Log.i(
                "zv-login",
                "login ok version=$version cookies=" + reply.cookies.size +
                    " webviewHasSession=" + Cookies.sessionVisible(webCookie) + " secureRejected=" + rejected,
            )
            if (rejected || !Cookies.sessionVisible(webCookie)) {
                fail(getString(R.string.err_cookie_rejected))
                return@Thread
            }
            val name = reply.data()?.optString("display_name")?.ifBlank { user } ?: user
            runOnUiThread { enterWeb(base, "已连接 zizvideo $version · $name") }
        }.start()
    }

    /**
     * 把登录响应的 Set-Cookie 灌进 WebView 的 cookie 存储；不灌的话网页那一侧还是未登录。
     * **整串原样写**（见 Cookies.forCookieManager）：自己重拼成 `name=value; path=/` 会把服务端
     * 刻意设的 HttpOnly / SameSite=Strict / Secure / Max-Age 丢光（服务端 authz_test 就在盯 HttpOnly）。
     */
    private fun pushCookies(base: String, cookies: List<String>) {
        val manager = CookieManager.getInstance()
        manager.setAcceptCookie(true)
        for (raw in cookies) {
            val value = Cookies.forCookieManager(raw)
            if (value == null) {
                android.util.Log.w("zv-login", "跳过不是 cookie 的 Set-Cookie：" + raw.take(60))
                continue
            }
            if (Cookies.droppedBySecureOverHttp(raw, base)) {
                // 照灌（让下面那段统一判失败），但要留一条能查的日志
                android.util.Log.w("zv-login", "cookie 带 Secure 而地址是 http，WebView 会拒收")
            }
            manager.setCookie(base, value)
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
        submitting = false
        // 提示里带上本次的目标（地址+用户名）与 HTTP 码：出问题时用户能直接看出来错在哪
        val detail = if (lastTarget.isBlank()) message else "$message（$lastTarget）"
        android.util.Log.w("zv-login", "login failed: " + message + " target=" + lastTarget)
        // 只有失败/过期才把登录信息露出来（用户要求）
        runOnUiThread { showForm(detail) }
        setBusy(false, detail)
        // 关键：失败原因要**弹出来**（电视上底部那行小字会被软键盘盖住，用户 2026-09-27 报障）
        runOnUiThread { showError(detail) }
    }

    private fun enterWeb(base: String, note: String) {
        settled = true
        submitting = false
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
        // 自测用的两个"外部开关"也要**透传**：启动参数落在 LoginActivity 上（launcher），
        // 不转发的话它们永远到不了 WebActivity（实测：更新源覆盖失效）。
        // ⚠️ `update_base` 只在**可调试包**里透传：LoginActivity 是 exported，本机任何 App 都能
        //    塞这个 extra 进来；release 包里连传都不传（WebActivity/Updater 那边还有第二道门）。
        if (BuildFlags.isDebuggable(this)) {
            this.intent.getStringExtra(WebActivity.EXTRA_UPDATE_BASE)?.let {
                intent.putExtra(WebActivity.EXTRA_UPDATE_BASE, it)
            }
        }
        if (this.intent.hasExtra(WebActivity.EXTRA_TV)) {
            intent.putExtra(WebActivity.EXTRA_TV, this.intent.getBooleanExtra(WebActivity.EXTRA_TV, false))
        }
        startActivity(intent)
        finish()
    }

    /** 离开登录页就把还没跑完的局域网扫描停掉（别让几十个线程跟着页面走）。 */
    override fun onDestroy() {
        try { scanCancel?.set(true) } catch (e: Exception) { /* 忽略 */ }
        super.onDestroy()
    }
}
