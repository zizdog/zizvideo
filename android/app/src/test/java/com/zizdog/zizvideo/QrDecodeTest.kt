package com.zizdog.zizvideo

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 扫码登录的解码门禁（用户 2026-09-27）。
 *
 * 覆盖两种相机帧：**紧凑行**（stride == width）和**带行填充**（stride > width，真机常见）。
 * 后者是"相机明明对着码却永远扫不到"的头号原因 —— 按 width 读会整幅横移。
 * 运行：cd android && bash tools/build.sh testDebugUnitTest
 */
class QrDecodeTest {

    private val link = "zizvideo://qr?id=qr_abc123&s=0f1e2d3c4b5a6978&u=aHR0cDovLzE5Mi4xNjguMS40Ojc3NjY"

    private fun matrix(size: Int): BitMatrix {
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 4,
        )
        return QRCodeWriter().encode(link, BarcodeFormat.QR_CODE, size, size, hints)
    }

    /** 把二维码画进一帧灰度图（白底黑块），pad 是每行尾部额外塞的字节（模拟相机行填充）。 */
    private fun frame(size: Int, pad: Int): Triple<ByteArray, Int, Int> {
        val m = matrix(size)
        val width = m.width
        val height = m.height
        val stride = width + pad
        val yuv = ByteArray(stride * height) { 0xFF.toByte() }
        for (y in 0 until height) {
            for (x in 0 until width) {
                if (m.get(x, y)) yuv[y * stride + x] = 0x00
            }
        }
        return Triple(yuv, width, height)
    }

    @Test
    fun decodesTightFrame() {
        val (yuv, w, h) = frame(320, 0)
        assertEquals(link, QrDecode.fromYuv(yuv, w, h, w))
    }

    @Test
    fun decodesPaddedFrame() {
        // 真机 Y 平面常见 padding（16/32 字节对齐）；按 width 读会解不出来
        val (yuv, w, h) = frame(320, 48)
        assertEquals(link, QrDecode.fromYuv(yuv, w, h, w + 48))
    }

    @Test
    fun blankFrameIsNull() {
        val yuv = ByteArray(320 * 320) { 0xFF.toByte() }
        assertNull(QrDecode.fromYuv(yuv, 320, 320, 320))
    }

    @Test
    fun refusesShortBuffer() {
        assertNull(QrDecode.fromYuv(ByteArray(10), 320, 320, 320))
    }
}
