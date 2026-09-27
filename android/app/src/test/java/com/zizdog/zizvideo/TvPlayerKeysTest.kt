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

    private fun decide(code: Int, repeat: Int = 0, isTv: Boolean = true, onControl: Boolean = false) =
        TvPlayerKeys.decide(code, KeyEvent.ACTION_DOWN, repeat, isTv, onControl)

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
        assertEquals(TvPlayerKeys.Action.PREV, decide(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals(TvPlayerKeys.Action.NEXT, decide(KeyEvent.KEYCODE_DPAD_DOWN))
    }

    @Test
    fun menuOpensChrome() {
        assertEquals(TvPlayerKeys.Action.FOCUS_CHROME, decide(KeyEvent.KEYCODE_MENU))
    }

    @Test
    fun neverStealsFromButtons() {
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_CENTER, onControl = true))
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_MENU, onControl = true))
    }

    @Test
    fun phonesAreUntouched() {
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_CENTER, isTv = false))
        assertEquals(TvPlayerKeys.Action.NONE, decide(KeyEvent.KEYCODE_DPAD_DOWN, isTv = false))
    }

    @Test
    fun keyUpIsIgnored() {
        assertEquals(
            TvPlayerKeys.Action.NONE,
            TvPlayerKeys.decide(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.ACTION_UP, 0, true, false),
        )
    }
}
