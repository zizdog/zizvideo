package com.zizdog.zizvideo

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer

/**
 * 相机 Y 平面 → 二维码内容（扫码登录用，用户 2026-09-27）。
 *
 * 单独抽出来是为了**能测**：这段最容易错的地方是"行的跨度"（rowStride ≥ width，相机常常带填充），
 * 一旦按 width 读，画面会横着错位、永远解不出来 —— 而模拟器没有真实场景可扫，
 * 只能靠单测把这段钉住（见 app/src/test/.../QrDecodeTest.kt）。
 */
object QrDecode {

    /** yuv 是相机 Y 平面（灰度即可），width/height 是图像尺寸，rowStride 是每行实际字节数。 */
    fun fromYuv(yuv: ByteArray, width: Int, height: Int, rowStride: Int): String? {
        if (width <= 0 || height <= 0) return null
        val stride = if (rowStride >= width) rowStride else width
        if (yuv.size < stride * height) return null
        return try {
            val source = PlanarYUVLuminanceSource(yuv, stride, height, 0, 0, width, height, false)
            val reader = MultiFormatReader().apply {
                setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
            }
            try {
                reader.decodeWithState(BinaryBitmap(HybridBinarizer(source)))?.text
            } finally {
                reader.reset()
            }
        } catch (e: Exception) {
            null // 没找到码是常态（每帧都可能在找一个不在画面里的码），不算错误
        }
    }
}
