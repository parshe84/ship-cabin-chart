package com.parshe84.gpssender

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import kotlin.math.max

/**
 * Signal strength (C/N0, dB-Hz) of every tracked satellite as a bar in its system's colour,
 * strongest first; solid bars are used in the fix. 40+ dB-Hz is a strong signal, below 20 is weak.
 */
class SignalBarsView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    var satellites: List<Satellite> = emptyList()
        set(value) {
            field = value.filter { it.cn0 > 0 }.sortedWith(compareByDescending<Satellite> { it.used }.thenByDescending { it.cn0 })
            invalidate()
        }

    private val dp = resources.displayMetrics.density
    private val bar = Paint(Paint.ANTI_ALIAS_FLAG)
    private val grid = Paint().apply { color = 0x2000E5FF; strokeWidth = 1f * dp }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF6F8AA6.toInt()
        textSize = 8f * dp
        textAlign = Paint.Align.CENTER
        typeface = Typeface.MONOSPACE
    }
    private val axis = Paint(label).apply { textAlign = Paint.Align.LEFT }
    private val rect = RectF()

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), (120 * dp).toInt())
    }

    override fun onDraw(canvas: Canvas) {
        val top = 6f * dp
        val bottom = height - 14f * dp
        val left = 22f * dp
        val h = bottom - top
        for (db in listOf(20, 40)) {
            val y = bottom - h * db / 50f
            canvas.drawLine(left, y, width.toFloat(), y, grid)
            canvas.drawText("$db", 0f, y + 3f * dp, axis)
        }
        if (satellites.isEmpty()) return
        val n = satellites.size
        val slot = (width - left) / max(n, 12)
        val w = slot * 0.66f
        satellites.forEachIndexed { i, s ->
            val x = left + i * slot + (slot - w) / 2
            val y = bottom - h * (s.cn0.coerceIn(0f, 50f) / 50f)
            rect.set(x, y, x + w, bottom)
            bar.style = if (s.used) Paint.Style.FILL else Paint.Style.STROKE
            bar.strokeWidth = 1.2f * dp
            bar.color = if (s.used) s.system.color else (s.system.color and 0x00FFFFFF or (0xA0 shl 24))
            canvas.drawRoundRect(rect, 2f * dp, 2f * dp, bar)
            if (slot >= 14f * dp) canvas.drawText(s.svid.toString(), x + w / 2, height - 3f * dp, label)
        }
    }
}
