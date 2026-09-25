package com.zizdog.zizvideo

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/**
 * 换 App 图标（用户 2026-09-25："增加换 app 图标功能。默认图标设置为 dog.svg，可选为图2.svg"）。
 *
 * 做法是安卓官方的 activity-alias 套路：同一份代码挂两个别名（.IconDog / .IconFig2），
 * 每个别名带自己的 android:icon；运行时**只启用一个**（另一个 DISABLED），桌面就显示那一个。
 *   · 必须保证"同一时刻只有一个启用"，否则桌面会出现两个图标；
 *   · 切换用 DONT_KILL_APP：不重启进程，用户切回桌面就能看到新图标；
 *   · 默认值写在清单里（IconDog enabled=true / IconFig2 enabled=false），全新安装就是 dog。
 */
object AppIcon {

    const val DOG = "dog"
    const val FIG2 = "fig2"

    /** 与清单里的 android:name 一一对应（改一个就得改另一个）。 */
    private val ALIASES = mapOf(
        DOG to ".IconDog",
        FIG2 to ".IconFig2",
    )

    val KEYS = listOf(DOG, FIG2)

    fun label(key: String): String = when (key) {
        FIG2 -> "图2（音符）"
        else -> "默认（狗头标）"
    }

    /** 现在用的是哪个图标。 */
    fun current(context: Context): String {
        for ((key, alias) in ALIASES) {
            val state = context.packageManager.getComponentEnabledSetting(ComponentName(context, context.packageName + alias))
            if (state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) return key
        }
        // 都是 DEFAULT（用户没切过）⇒ 清单里的初值 = dog
        return DOG
    }

    /** 切图标：选中的 ENABLED，其余 DISABLED。返回是否真的切了。 */
    fun set(context: Context, key: String): Boolean {
        val want = ALIASES[key] ?: return false
        if (current(context) == key) return false
        val pm = context.packageManager
        for ((k, alias) in ALIASES) {
            val name = ComponentName(context, context.packageName + alias)
            val state = if (k == key) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            pm.setComponentEnabledSetting(name, state, PackageManager.DONT_KILL_APP)
        }
        // 让桌面/启动器尽快刷新（有些 ROM 不看这一下，就得等它自己那一轮；如实告知用户）
        context.sendBroadcast(android.content.Intent(android.content.Intent.ACTION_PACKAGE_CHANGED,
            android.net.Uri.parse("package:" + context.packageName)))
        android.util.Log.i("zv-icon", "已切换 App 图标：$key（$want）")
        return true
    }
}
