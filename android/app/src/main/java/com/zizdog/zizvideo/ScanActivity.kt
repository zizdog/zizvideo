package com.zizdog.zizvideo

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

/**
 * 手机端扫码登录（用户 2026-09-27："手机 app 直接扫码不需要输入信息即可登录"）。
 *
 * 它只做三件事：开相机取帧 → 解出 `zizvideo://qr?...` → 拿本机已有的会话去 /auth/qr/claim 确认。
 * 会话 cookie 从 WebView 的 CookieManager 里取（App 平时就在用同一份），所以"手机已登录"是前提；
 * 没登录就直接告诉用户先在手机上登录，而不是假装成功。
 *
 * 为什么用 CameraX + ZXing core：CameraX 是安卓官方的取帧/生命周期封装（比自己写 Camera2 稳），
 * ZXing core 是纯 Java 解码器（不带原生库，APK 只多几百 KB）。
 */
class ScanActivity : AppCompatActivity() {

    private lateinit var preview: PreviewView
    private lateinit var hint: TextView
    private val executor = Executors.newSingleThreadExecutor()
    private var handled = false

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else finishWith("没有相机权限，扫不了码")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_scan)
        preview = findViewById(R.id.preview)
        hint = findViewById(R.id.scanHint)
        Ui.padSystemBars(findViewById(R.id.scanRoot))
        // 自测口：不给相机也能验"确认"这条链路（模拟器没有真实场景可扫）
        val injected = intent?.getStringExtra(EXTRA_TEST_PAYLOAD)
        if (!injected.isNullOrBlank()) {
            hint.text = "自测：直接确认"
            handlePayload(injected)
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = try {
                future.get()
            } catch (e: Exception) {
                finishWith("相机起不来：" + e.javaClass.simpleName)
                return@addListener
            }
            val previewUse = Preview.Builder().build().also {
                it.setSurfaceProvider(preview.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor) { proxy -> analyze(proxy) }
            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUse, analysis)
                hint.text = "把电视上的二维码放进框里"
            } catch (e: Exception) {
                finishWith("相机打不开：" + e.javaClass.simpleName)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun analyze(proxy: ImageProxy) {
        if (handled) { proxy.close(); return }
        try {
            val plane = proxy.planes[0]
            val data = ByteArray(plane.buffer.remaining())
            plane.buffer.get(data)
            val text = QrDecode.fromYuv(data, proxy.width, proxy.height, plane.rowStride)
            if (!text.isNullOrBlank()) {
                handled = true
                runOnUiThread { handlePayload(text) }
            }
        } catch (e: Exception) {
            Log.w("zv-qr", "analyze: " + e.javaClass.simpleName)
        } finally {
            proxy.close()
        }
    }

    /** 扫到内容 → 交给 QrClaim 去确认（解析/核对/HTTP 都在那边，两个入口共用）。 */
    private fun handlePayload(payload: String) {
        hint.text = "正在确认…"
        Thread {
            val message = QrClaim.fromPayload(this, payload)
            runOnUiThread { finishWith(message, QrClaim.isOk(message)) }
        }.start()
    }

    private fun finishWith(message: String, ok: Boolean = false) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show()
        Log.i("zv-qr", (if (ok) "scan ok: " else "scan fail: ") + message)
        if (ok) {
            // 成功给用户看一眼再退（电视那边同时会自己跳）
            preview.postDelayed({ finish() }, 900)
        } else {
            hint.text = message
            handled = false
        }
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }

    companion object {
        /** 自测：直接喂一段深链（模拟器上没有真实二维码可扫时用）。 */
        const val EXTRA_TEST_PAYLOAD = "qr_payload"
    }
}
