package com.zizdog.zizvideo

import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.ServerSocket

/**
 * 原生播放页的队列来源（回归护栏）。
 *
 * 用户 2026-10-01 报障："每次进这个界面，播放的视频都不是我选的视频，返回后列表也变了。"
 * 真因之一：`single`（电视端把 WebView 解不了的 HEVC/AV1 交给原生硬解）取媒体 id 时只看 `query` ——
 * 而交接过来的 `query` 对 single 是**空的**，于是队列 0 条、页面写"这条没有可播的内容"，
 * 后台那个上一条还在接着放，看着就像"放了别的片子"。
 *
 * 判据就是"请求打到了哪条 id"：本地单测里 `org.json` 是 android.jar 的桩（解析不出东西），
 * 所以断言请求路径而不是返回的列表 —— 这正是这个 bug 的判据（修好前一条请求都不会发）。
 */
class ZvApi2Test {
    /** 够用的本机假服务端：只记下收到的路径，回一个空信封。 */
    private class Stub {
        val hits = mutableListOf<String>()
        private val socket = ServerSocket(0)
        val base = "http://127.0.0.1:" + socket.localPort

        init {
            Thread {
                while (true) {
                    val sock = try { socket.accept() } catch (e: Exception) { return@Thread }
                    try {
                        val input = sock.getInputStream().bufferedReader()
                        val line = input.readLine() ?: continue
                        hits.add(line.split(" ").getOrNull(1) ?: "/")
                        while (true) {
                            val h = input.readLine() ?: break
                            if (h.isEmpty()) break
                        }
                        val body = "{}".toByteArray(Charsets.UTF_8)
                        val out = sock.getOutputStream()
                        out.write(
                            ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
                                body.size + "\r\nConnection: close\r\n\r\n").toByteArray(Charsets.UTF_8),
                        )
                        out.write(body)
                        out.flush()
                    } catch (e: Exception) {
                        // 客户端断开就算了，别让后台线程炸掉
                    } finally {
                        try { sock.close() } catch (e: Exception) { }
                    }
                }
            }.apply { isDaemon = true }.start()
        }

        fun stop() { try { socket.close() } catch (e: Exception) { } }
    }

    private fun withServer(body: (Stub) -> Unit) {
        val stub = Stub()
        try {
            body(stub)
        } finally {
            stub.stop()
        }
    }

    @Test
    fun singleQueueAsksForTheMediaIdNotTheEmptyQuery() {
        withServer { stub ->
            // 交接路径长这样：id 在 mediaId，query 是空的（这就是修好前失败的那条）
            ZvApi2.queueDetailed(stub.base, "single", "", "", "med_abc")
            assertEquals(listOf("/api/v1/media/med_abc"), stub.hits)
        }
    }

    @Test
    fun singleQueueStillAcceptsTheIdInQuery() {
        withServer { stub ->
            // 老调用方（PlaybackService）把 id 塞在 query 里 —— 不能因为这个修复就断掉
            ZvApi2.queueDetailed(stub.base, "single", "", "med_old")
            assertEquals(listOf("/api/v1/media/med_old"), stub.hits)
        }
    }

    @Test
    fun singleQueueWithoutIdAsksNothing() {
        withServer { stub ->
            val res = ZvApi2.queueDetailed(stub.base, "single", "", "")
            assertEquals("没 id 就别发请求", emptyList<String>(), stub.hits)
            assertEquals(0, res.list.size)
        }
    }

    @Test
    fun singleIdPrefersMediaId() {
        assertEquals("med_new", ZvApi2.singleId("med_new", "med_old"))
        assertEquals("med_abc", ZvApi2.singleId("  med_abc  ", ""))
        assertEquals("", ZvApi2.singleId("   ", "  "))
    }
}
