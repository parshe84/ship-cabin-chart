package com.parshe84.gpssender

import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Sky plot: the sky seen from the phone, horizon at the edge and zenith in the centre, north up.
 * Each satellite is a dot in its system's colour: filled and glowing when used in the fix,
 * hollow when only tracked; the dot grows with signal strength.
 */
class SkyView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    var satellites: List<Satellite> = emptyList()
        set(value) {
            field = value
            invalidate()
        }

    private val dp = resources.displayMetrics.density
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f * dp
        color = 0x4000E5FF
    }
    private val cross = Paint(ring).apply { color = 0x2000E5FF }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF6F8AA6.toInt()
        textSize = 11f * dp
        textAlign = Paint.Align.CENTER
        typeface = Typeface.MONOSPACE
    }
    private val north = Paint(label).apply { color = 0xFFFF2BD6.toInt(); typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply { maskFilter = BlurMaskFilter(8f * dp, BlurMaskFilter.Blur.NORMAL) }
    private val svid = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 8.5f * dp
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    }

    init {
        setLayerType(LAYER_TYPE_SOFTWARE, null) // BlurMaskFilter needs software rendering
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(w, w) // square
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val r = min(cx, cy) - 16f * dp
        // Elevation rings at 0°, 30°, 60° and the zenith cross.
        for (e in listOf(0, 30, 60)) canvas.drawCircle(cx, cy, r * (90 - e) / 90f, ring)
        canvas.drawLine(cx - r, cy, cx + r, cy, cross)
        canvas.drawLine(cx, cy - r, cx, cy + r, cross)
        canvas.drawText("N", cx, cy - r - 4f * dp, north)
        canvas.drawText("S", cx, cy + r + 13f * dp, label)
        canvas.drawText("E", cx + r + 9f * dp, cy + 4f * dp, label)
        canvas.drawText("W", cx - r - 9f * dp, cy + 4f * dp, label)
        canvas.drawText("30°", cx + 3f * dp, cy - r * 60 / 90f - 3f * dp, label)

        // Unused first, so used satellites are drawn on top.
        for (s in satellites.sortedBy { it.used }) {
            if (s.elevation <= 0f && s.azimuth <= 0f) continue
            val dist = r * (90f - s.elevation.coerceIn(0f, 90f)) / 90f
            val a = Math.toRadians(s.azimuth.toDouble())
            val x = cx + (dist * sin(a)).toFloat()
            val y = cy - (dist * cos(a)).toFloat()
            val size = (4f + (s.cn0.coerceIn(0f, 50f) / 50f) * 6f) * dp
            val color = s.system.color
            if (s.used) {
                glow.color = color and 0x00FFFFFF or (0x90 shl 24)
                canvas.drawCircle(x, y, size + 3f * dp, glow)
                dot.style = Paint.Style.FILL
                dot.color = color
                canvas.drawCircle(x, y, size, dot)
                svid.color = Color.BLACK
            } else {
                dot.style = Paint.Style.STROKE
                dot.strokeWidth = 1.5f * dp
                dot.color = color and 0x00FFFFFF or (0xB0 shl 24)
                canvas.drawCircle(x, y, size, dot)
                svid.color = dot.color
            }
            if (size >= 7f * dp) canvas.drawText(s.svid.toString(), x, y + 3f * dp, svid)
        }
    }
}
