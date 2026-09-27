package com.zizdog.zizvideo

import android.view.KeyEvent

/**
 * 播放页在电视上"这个按键该谁处理"的判据（用户 2026-09-27 同类问题，抽出来是为了能测）。
 *
 * 背景：media3 的 PlayerView 是 clickable 的，AOSP 的 `View.onKeyDown` 会把确定键吃掉去 performClick
 * （效果只是把控件条显示/藏起来）—— 所以原来写在 `onKeyDown` 里的"确定=播放/暂停"**永远收不到**，
 * 电视上按确定不会暂停（实测确认）。修法是把确定键提到 `dispatchKeyEvent`（视图之前接住）。
 *
 * 两条规矩：
 *   ① 焦点在真正的按钮上（收藏/缓存/停止…）时**不抢** —— 电视上要用确定点这些按钮；
 *   ② 只有电视端才接管，手机端一行都不变。
 */
object TvPlayerKeys {

    enum class Action { NONE, TOGGLE, FOCUS_CHROME, PREV, NEXT, SEEK_BACK, SEEK_FWD }

    /**
     * "我们自己那排控件"的 id（收藏/喜欢/稍后/倍速/缓存/画中画/停止）——只有焦点落在这些上才不抢按键。
     *
     * ⚠️ 坑（2026-09-27 真机验收抓出来的）：一开始按"是不是 Button/ImageButton"判断，结果电视上
     * **默认焦点就是 media3 控件条的 `exo_settings`（ImageButton）**，于是确定键与菜单键被一起判成
     * "不抢" ⇒ 按确定弹出的是 media3 设置弹窗、片子不停（A1/A2 两条验收都不通过）。
     * 所以这里必须**按 id 白名单**判断，media3 那些 `exo_*` 一律不算"我们的控件"。
     */
    val OWN_CONTROL_IDS: Set<Int> = setOf(
        R.id.fav, R.id.like, R.id.later, R.id.speed, R.id.offline, R.id.pip, R.id.stop,
    )

    fun decide(keyCode: Int, action: Int, repeat: Int, isTv: Boolean, focusId: Int): Action {
        if (!isTv || action != KeyEvent.ACTION_DOWN) return Action.NONE
        if (focusId in OWN_CONTROL_IDS) return Action.NONE // 焦点在我们自己的按钮上：交给系统点击
        return when (keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_SPACE,
            -> if (repeat > 0) Action.NONE else Action.TOGGLE // 按住不反复切
            KeyEvent.KEYCODE_MENU -> Action.FOCUS_CHROME // 底部那排控件遥控器够不到，菜单键把焦点送进去
            KeyEvent.KEYCODE_DPAD_LEFT -> Action.SEEK_BACK
            KeyEvent.KEYCODE_DPAD_RIGHT -> Action.SEEK_FWD
            KeyEvent.KEYCODE_DPAD_UP -> Action.PREV
            KeyEvent.KEYCODE_DPAD_DOWN -> Action.NEXT
            else -> Action.NONE
        }
    }
}
