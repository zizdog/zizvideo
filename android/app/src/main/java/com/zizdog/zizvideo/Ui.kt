package com.zizdog.zizvideo

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * 状态栏/刘海不许压住内容（用户 2026-09-23 报障：播放页「来自 X」跟系统状态栏重合）。
 * 根因：targetSdk 35（Android 15）起系统**强制 edge-to-edge**，内容默认画到状态栏下面。
 * 做法：显式 enableEdgeToEdge（各端行为一致）+ 把系统栏 insets 当 padding 垫在根布局上。
 */
object Ui {
    fun padSystemBars(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }
}
