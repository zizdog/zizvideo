package com.zizdog.zizvideo

import android.content.Context
import android.content.pm.ApplicationInfo

/**
 * 「这是不是可调试包」。
 *
 * 为什么不直接写 `BuildConfig.DEBUG`：本模块没开 buildConfig 生成（`app/build.gradle.kts` 不在
 * 本轮允许改的范围内），引它是编译不过的。这里取的是**同一个事实** —— AGP 生成 BuildConfig.DEBUG
 * 用的就是 buildType.isDebuggable，而它在安装包里就落在 `ApplicationInfo.FLAG_DEBUGGABLE` 上
 * （WebActivity 判 WebView 远程调试时用的也是它）。自测口（`update_base`）只认它：
 * release 包里连这个 extra 都不看，外部 Intent 无法替换更新源。
 */
object BuildFlags {
    fun isDebuggable(context: Context): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}
