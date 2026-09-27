package com.zizdog.zizvideo

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 电视播放页"这个键谁处理"的门禁（用户 2026-09-27 同类问题）。
 *
 * 最要紧的一条：确定键必须判成 TOGGLE（由 dispatchKeyEvent 提前接住）。原来它落在 onKeyDown 里，
 * 被 clickable 的 PlayerView 吃掉，电视上按确定不会暂停、还会把每次 idle 之后的第一下按键吞掉。
 * 第二条：焦点已经在按钮上时不许抢（否则电视上点不到"停止并退出"）。
 */
class TvPlayerKeysTest {

    // focusId 用 R.id.*：白名单判据本身就是"按 id"，所以测试也必须按 id 传
    private fun decide(code: Int, repeat: Int = 0, isTv: Boolean = true, focusId: Int = R.id.player) =
        TvPlayerKeys.decide(code, KeyEvent.ACTION_DOWN, repeat, isTv, focusId)

    @Test
    fun okTogglesPlayback() {
        assertEquals(TvPlayerKeys.Action.TOGGLE, decide(KeyEvent.KEYCODE_DPAD_CENTER))
        assertEquals(TvPlayerKeys.Action.TOGGLE, decide(KeyEvent.KEYCODE_ENTER))
        assertEquals(TvPlayerKeys.Action.TOGGLE, decide(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        // 按住不反复切
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_CENTER, repeat = 3))
    }

    @Test
    fun arrowsKeepTheirPlayerMeaning() {
        assertEquals(TvPlayerKeys.Action.SEEK_BACK, decide(KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals(TvPlayerKeys.Action.SEEK_FWD, decide(KeyEvent.KEYCODE_DPAD_RIGHT))
    }

    /** 两态模型（用户 2026-09-27："四个方向键都给了播放，怎么操作其它地方？"）：
        看片态下 ↑/↓ = **进控制条**（一次方向键就到，两个方向都行），换集搬到控制条的按钮里。 */
    @Test
    fun upDownEnterTheControls() {
        assertEquals(TvPlayerKeys.Action.FOCUS_CHROME, decide(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(TvPlayerKeys.Action.FOCUS_CHROME, decide(KeyEvent.KEYCODE_DPAD_DOWN))
        // 已经在控制条里：方向键留给系统做焦点导航（不抢）
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_DOWN, focusId = R.id.prev))
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_RIGHT, focusId = R.id.fav))
    }

    /** 换集按钮必须在"我们自己的控件"白名单里（否则确定键会被 App 抢走，按钮点不动）。 */
    @Test
    fun episodeButtonsAreOwnControls() {
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_CENTER, focusId = R.id.prev))
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_CENTER, focusId = R.id.next))
    }

    @Test
    fun menuOpensChrome() {
        assertEquals(TvPlayerKeys.Action.FOCUS_CHROME, decide(KeyEvent.KEYCODE_MENU))
    }

    /** 只有"我们自己那排控件"才不抢；media3 控件条（exo_*）与画面本身都要抢。
        这条是验收抓回来的：原来按 Button/ImageButton 判断，被 media3 的 exo_settings 骗过去了。 */
    @Test
    fun neverStealsFromOwnControlsOnly() {
        for (id in TvPlayerKeys.OWN_CONTROL_IDS) {
            assertEquals("我们的控件 $id 上不该抢确定键", TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_CENTER, focusId = id))
            assertEquals("我们的控件 $id 上不该抢菜单键", TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_MENU, focusId = id))
        }
        // 画面（player）与"未知 id"（media3 的 exo_* 按钮）都要接管
        assertEquals(TvPlayerKeys.Action.TOGGLE, decide(KeyEvent.KEYCODE_DPAD_CENTER, focusId = R.id.player))
        assertEquals(TvPlayerKeys.Action.TOGGLE, decide(KeyEvent.KEYCODE_DPAD_CENTER, focusId = 0))
        assertEquals(TvPlayerKeys.Action.FOCUS_CHROME, decide(KeyEvent.KEYCODE_MENU, focusId = 0))
    }

    @Test
    fun phonesAreUntouched() {
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_CENTER, isTv = false))
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_DOWN, isTv = false))
    }

    /** 长按**不再是入口**（用户 2026-09-27："长按为什么要设置？！…遥控器设置按钮就已经可以了"）：
        确定键按下就是播放/暂停，按住也还是播放/暂停；要进控制条有「菜单/设置」键与 ↑↓ 两条明路。 */
    @Test
    fun okPressAlwaysTogglesNoLongPressEntry() {
        assertEquals(TvPlayerKeys.Action.TOGGLE, TvPlayerKeys.okAction(true, R.id.player))
        // 焦点已经在我们自己的控件上：别抢（不然点不动"停止并退出"）
        assertEquals(TvPlayerKeys.Action.NONE, TvPlayerKeys.okAction(true, R.id.stop))
        // 手机端一行都不变
        assertEquals(TvPlayerKeys.Action.NONE, TvPlayerKeys.okAction(false, R.id.player))
        // 进控制条的两条明路仍在
        assertEquals(TvPlayerKeys.Action.FOCUS_CHROME, decide(KeyEvent.KEYCODE_MENU))
        assertEquals(TvPlayerKeys.Action.FOCUS_CHROME, decide(KeyEvent.KEYCODE_DPAD_UP))
    }

    @Test
    fun keyUpIsIgnored() {
        assertEquals(
            TvPlayerKeys.Action.NONE,
            TvPlayerKeys.decide(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.ACTION_UP, 0, true, R.id.player),
        )
    }
}
