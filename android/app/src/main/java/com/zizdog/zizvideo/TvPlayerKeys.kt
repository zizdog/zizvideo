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

    enum class Action { NONE, TOGGLE, FOCUS_CHROME, SEEK_BACK, SEEK_FWD }

    /**
     * "我们自己那排控件"的 id（收藏/喜欢/稍后/倍速/缓存/画中画/停止）——只有焦点落在这些上才不抢按键。
     *
     * ⚠️ 坑（2026-09-27 真机验收抓出来的）：一开始按"是不是 Button/ImageButton"判断，结果电视上
     * **默认焦点就是 media3 控件条的 `exo_settings`（ImageButton）**，于是确定键与菜单键被一起判成
     * "不抢" ⇒ 按确定弹出的是 media3 设置弹窗、片子不停（A1/A2 两条验收都不通过）。
     * 所以这里必须**按 id 白名单**判断，media3 那些 `exo_*` 一律不算"我们的控件"。
     */
    val OWN_CONTROL_IDS: Set<Int> = setOf(
        R.id.prev, R.id.next, R.id.fav, R.id.like, R.id.later, R.id.speed, R.id.offline, R.id.pip, R.id.stop,
    )

    /**
     * 确定键怎么走：**按下即播放/暂停**（用户 2026-09-27 明确："长按为什么要设置？！…
     * 遥控器设置按钮就已经可以了"）。
     *
     * 历史：0.4.3~0.4.6 那几版把"长按确定"当进控制条的入口，用户否了 —— 遥控器有「菜单/设置」键，
     * ↑↓ 也能进控制条（见 decide），不需要一个屏幕上写不出来、还跟遥控器连发键打架的长按手势。
     */
    fun okAction(isTv: Boolean, focusId: Int): Action {
        if (!isTv || focusId in OWN_CONTROL_IDS) return Action.NONE
        return Action.TOGGLE
    }

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
            KeyEvent.KEYCODE_MENU -> Action.FOCUS_CHROME
            KeyEvent.KEYCODE_DPAD_LEFT -> Action.SEEK_BACK
            KeyEvent.KEYCODE_DPAD_RIGHT -> Action.SEEK_FWD
            // 两态模型（用户 2026-09-27："四个方向键都给了播放，怎么操作其它地方？"）：
            // 看片态下 ↑/↓ = **进控制条**（一次方向键就够，且两个方向都进，不会"按了没反应"）；
            // 换集搬到控制条里的「上一集/下一集」按钮。控制条里方向键全部用于移动焦点。
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> Action.FOCUS_CHROME
            else -> Action.NONE
        }
    }
}
