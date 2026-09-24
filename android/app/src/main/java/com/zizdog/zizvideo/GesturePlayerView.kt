package com.zizdog.zizvideo

import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import androidx.media3.ui.PlayerView

/**
 * B5：能"旁听"触摸的 PlayerView。
 *
 * 为什么要子类：想加双击点赞/长按快进，就得拿到**完整的手势序列**（DOWN…UP）。
 *   · 用 setOnTouchListener 挂在 PlayerView 上：控件条（居中的播放键、底部拖动条）会先把触摸吃掉，
 *     旁边的双击根本收不到（实测：长按能用、双击完全不触发）；
 *   · 放一层透明 View 盖在上面：只能拿到第一次 DOWN（不消费就收不到 UP，手势序列断掉），
 *     消费了又会把控件条的按钮/拖动条全挡住。
 * 子类里覆写 dispatchTouchEvent：**先观察、再原样交给 super**，控件条照常工作，手势也不丢。
 */
class GesturePlayerView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : PlayerView(context, attrs, defStyleAttr) {

    /** 每个触摸事件都会回调一次（观察用，不改变分发）。 */
    var onGesture: ((MotionEvent) -> Unit)? = null

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        onGesture?.invoke(ev)
        return super.dispatchTouchEvent(ev)
    }
}
