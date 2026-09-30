package com.zizdog.zizvideo

import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 局域网里自动找 zizvideo 服务器（用户 2026-09-28："首次登录自动探测局域网的服务 zizvideo 服务器，
 * 可以直接选择，然后只用输入用户名密码"）。
 *
 * 为什么是"扫端口 + 指纹接口"，不是 mDNS：
 *   · 服务端是**纯 HTTP**（`cmd/server` 用 ListenAndServe，没有 TLS、也没有 mDNS 广播），
 *     而且已经装在用户家里的那些版本不会为这次改动升级 ⇒ 客户端自己扫最省事、对老版本一样有效；
 *   · 只扫自己所在的 /24（最多 254 个地址、几十个并发、几百毫秒超时），实测 1~2 秒；
 *   · 认领靠**指纹接口**：未登录就能访问的 `/api/v1/setup/status` 会回
 *     `{"data":{"needs_setup":…,"version":"0.4.x"}}` —— 别的服务占着同一个端口也冒充不了。
 *
 * 纯逻辑（网段枚举 / 候选生成 / 指纹解析）全在这里，单测直接喂字符串断言，不碰真网络。
 */
object LanScan {

    /** 一台被认出来的服务器。 */
    data class Found(
        val base: String,        // http://192.168.1.20:7766
        val version: String,
        val needsSetup: Boolean,
        val allowRegister: Boolean,
    )

    /** zizvideo 默认端口（见 internal/config：listen 127.0.0.1:7766 / 局域网部署改成 0.0.0.0:7766）。 */
    const val DEFAULT_PORT = 7766

    /** 一次最多扫多少个地址（超大网段时截断，别把手机/电视扫没电）。 */
    const val MAX_HOSTS = 512

    /** 指纹接口（未登录可访问；见 internal/api/handlers_auth.go 的 HandleSetupStatus）。 */
    const val STATUS_PATH = "/api/v1/setup/status"

    /**
     * 算出一块网卡要扫的主机地址（跳过网络号/广播/自己）。
     * /24 及以上（前缀 >= 24）就扫本 /24 的 1..254；
     * 更宽的网段（/16、/8）先扫自己在的那个 /24，再往左右各扩一个 /24，最后按 cap 截断。
     */
    fun hostsFor(ip: String, prefix: Int, cap: Int = MAX_HOSTS): List<String> {
        val parts = ip.split(".").mapNotNull { it.toIntOrNull() }
        if (parts.size != 4 || parts.any { it < 0 || it > 255 }) return emptyList()
        val p = prefix.coerceIn(8, 32)
        // /31、/32 是点到点/单机：没有可扫的邻居
        if (p >= 31) return emptyList()
        val (a, b, c, d) = parts
        val out = ArrayList<String>()
        val thirds = ArrayList<Int>()
        thirds.add(c)
        var delta = 1
        while (thirds.size < 3 && delta <= 256) {
            thirds.add((c + delta) and 0xFF)
            if (thirds.size < 3) thirds.add((c - delta + 256) and 0xFF)
            delta++
        }
        for (t in thirds) {
            for (i in 1..254) {
                val host = "$a.$b.$t.$i"
                if (host == ip) continue
                out.add(host)
                if (out.size >= cap) return out
            }
            // /24 就只扫本网段，别扩到隔壁
            if (p >= 24) break
        }
        return out
    }

    /** 本机所有可用的 IPv4 网段（地址 + 前缀长度）。回环/链路本地/未启用的一律跳过。 */
    fun localNets(): List<Pair<String, Int>> {
        val out = ArrayList<Pair<String, Int>>()
        try {
            for (nif in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp || nif.isLoopback || nif.isPointToPoint) continue
                val name = nif.name ?: ""
                // VPN/蜂窝的虚拟网卡扫了也没用（zizvideo 在局域网里）
                if (name.startsWith("tun") || name.startsWith("utun") || name.startsWith("ppp") ||
                    name.startsWith("rmnet") || name.startsWith("ccmni")
                ) continue
                for (ia in nif.interfaceAddresses) {
                    val addr = ia.address
                    if (addr !is Inet4Address) continue
                    val host = addr.hostAddress ?: continue
                    if (host.startsWith("169.254.")) continue // 链路本地
                    out.add(Pair(host, ia.networkPrefixLength.toInt()))
                }
            }
        } catch (e: Exception) {
            // 读不到网卡就当"没有可扫的网段"，调用方会回落到手动输入
        }
        return out
    }

    /**
     * 从用户填过/存过的地址里抠端口（"192.168.1.9:9000"、"http://host:9000" 都要能认）。
     * 抠不到返回 0（= 只有默认端口）—— 这样反代/自定义端口的部署也能被搜到，而不是只认 7766。
     */
    fun portOf(raw: String): Int {
        val s = raw.trim()
        if (s.isEmpty()) return 0
        val noScheme = s.substringAfter("://", s).substringBefore("/")
        val tail = noScheme.substringAfterLast(":", "")
        val n = tail.toIntOrNull() ?: return 0
        return if (n in 1..65535) n else 0
    }

    /** 候选 (host, port)：主机 × 端口。端口顺序决定优先级。 */    fun candidates(
        nets: List<Pair<String, Int>>,
        ports: List<Int>,
        cap: Int = MAX_HOSTS,
    ): List<Pair<String, Int>> {
        val clean = ports.filter { it in 1..65535 }.distinct()
        if (clean.isEmpty()) return emptyList()
        val out = ArrayList<Pair<String, Int>>()
        for ((ip, prefix) in nets) {
            for (host in hostsFor(ip, prefix, cap)) {
                for (port in clean) {
                    out.add(Pair(host, port))
                    if (out.size >= cap * clean.size) return out
                }
            }
        }
        return out
    }

    /**
     * 解析 `/api/v1/setup/status` 的响应体；**不是 zizvideo 就返回 null**。
     * 判据：必须同时出现 needs_setup 与 version 两个键（宁可漏报，不误报）；
     * 手写正则而不引 JSON 库 —— 这段逻辑要在纯 JVM 单测里跑，Android 的 org.json 在单测里是桩。
     */
    fun parseStatus(base: String, body: String): Found? {
        if (body.isBlank()) return null
        val need = Regex("\"needs_setup\"\\s*:\\s*(true|false)").find(body) ?: return null
        val ver = Regex("\"version\"\\s*:\\s*\"([^\"]*)\"").find(body) ?: return null
        val reg = Regex("\"allow_register\"\\s*:\\s*(true|false)").find(body)?.groupValues?.get(1) == "true"
        return Found(
            base = base,
            version = ver.groupValues[1],
            needsSetup = need.groupValues[1] == "true",
            allowRegister = reg,
        )
    }

    /** TCP 探活 + 指纹确认；不是我们的服务器返回 null。 */
    fun probe(host: String, port: Int, timeoutMs: Int): Found? {
        try {
            Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs) }
        } catch (e: Exception) {
            return null
        }
        val base = "http://$host:$port"
        val body = httpGet(base + STATUS_PATH, timeoutMs) ?: return null
        return parseStatus(base, body)
    }

    private fun httpGet(url: String, timeoutMs: Int): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = true
                // 带上 UA：有的反代会拦没有 UA 的请求（浏览器能过、App 过不去的那类）
                setRequestProperty("User-Agent", "zizvideo-android/lan-scan")
            }
            if (conn.responseCode !in 200..299) return null
            conn.inputStream.bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            null
        } finally {
            try { conn?.disconnect() } catch (e: Exception) { /* 忽略 */ }
        }
    }

    /**
     * 扫一遍局域网；每找到一台就回调一次（回调在**后台线程**，调用方自己切主线程）。
     * `cancel` 置真即尽快收工（离开登录页时用）。
     */
    fun scan(
        ports: List<Int>,
        timeoutMs: Int = 350,
        threads: Int = 48,
        cancel: AtomicBoolean? = null,
        onFound: (Found) -> Unit,
    ): List<Found> {
        val cands = candidates(localNets(), ports)
        if (cands.isEmpty()) return emptyList()
        val found = Collections.synchronizedList(ArrayList<Found>())
        val seen = Collections.synchronizedSet(HashSet<String>())
        val pool = Executors.newFixedThreadPool(threads.coerceIn(1, 128))
        val latch = CountDownLatch(cands.size)
        for ((host, port) in cands) {
            pool.execute {
                try {
                    if (cancel?.get() == true) return@execute
                    val hit = probe(host, port, timeoutMs)
                    if (hit != null && seen.add(hit.base)) {
                        found.add(hit)
                        onFound(hit)
                    }
                } catch (e: Exception) {
                    // 单点失败不影响整轮扫描
                } finally {
                    latch.countDown()
                }
            }
        }
        pool.shutdown()
        // 每个任务都有硬超时（connect/read 都是 timeoutMs），这里再兜一个总时长，绝不挂死界面线程
        try { latch.await(60, TimeUnit.SECONDS) } catch (e: InterruptedException) { Thread.currentThread().interrupt() }
        try { pool.shutdownNow() } catch (e: Exception) { /* 忽略 */ }
        return found
    }
}
