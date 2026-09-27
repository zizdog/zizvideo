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

    fun decide(keyCode: Int, action: Int, repeat: Int, isTv: Boolean, focusIsControl: Boolean): Action {
        if (!isTv || action != KeyEvent.ACTION_DOWN) return Action.NONE
        if (focusIsControl) return Action.NONE // 焦点在按钮上：交给系统点击
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
