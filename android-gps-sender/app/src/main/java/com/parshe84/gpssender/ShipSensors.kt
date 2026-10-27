package com.parshe84.gpssender

import android.content.Context
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import kotlin.math.abs

/**
 * Phone sensors that are useful on a porthole:
 *  - barometer (if the phone has one): air pressure for the storm warning on the laptop;
 *  - rotation vector (compass): heading of the phone, corrected to true north with the
 *    magnetic declination at the current position. Works lying flat or standing on the glass.
 */
class ShipSensors(context: Context) : SensorEventListener {

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val pressureSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE)
    private val rotationSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)

    val hasBarometer get() = pressureSensor != null
    val hasCompass get() = rotationSensor != null

    /** Latest smoothed pressure in hPa, or null. */
    @Volatile var pressureHpa: Float? = null
        private set

    /** Latest true heading in degrees, or null. */
    @Volatile var headingTrue: Float? = null
        private set

    private var declination = 0f
    private val rotation = FloatArray(9)
    private val remapped = FloatArray(9)
    private val orientation = FloatArray(3)

    fun start() {
        pressureSensor?.let { sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
        rotationSensor?.let { sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }
    }

    fun stop() {
        sensorManager.unregisterListener(this)
    }

    fun updateLocation(location: Location) {
        declination = GeomagneticField(
            location.latitude.toFloat(),
            location.longitude.toFloat(),
            location.altitude.toFloat(),
            location.time,
        ).declination
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_PRESSURE -> {
                val p = event.values[0]
                // Exponential smoothing: pressure sensors are noisy, the trend is what matters.
                pressureHpa = pressureHpa?.let { it + (p - it) * 0.05f } ?: p
            }
            Sensor.TYPE_ROTATION_VECTOR -> {
                SensorManager.getRotationMatrixFromVector(rotation, event.values)
                // Phone standing upright (e.g. leaning on the porthole glass): measure where the
                // back camera points instead of where the top edge points.
                val upright = abs(rotation[7]) > 0.7f
                val matrix = if (upright) {
                    SensorManager.remapCoordinateSystem(rotation, SensorManager.AXIS_X, SensorManager.AXIS_Z, remapped)
                    remapped
                } else {
                    rotation
                }
                SensorManager.getOrientation(matrix, orientation)
                val magnetic = Math.toDegrees(orientation[0].toDouble()).toFloat()
                val trueHeading = ((magnetic + declination) % 360f + 360f) % 360f
                headingTrue = headingTrue?.let { smoothAngle(it, trueHeading, 0.15f) } ?: trueHeading
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit

    private fun smoothAngle(from: Float, to: Float, k: Float): Float {
        var d = to - from
        if (d > 180f) d -= 360f
        if (d < -180f) d += 360f
        return ((from + d * k) % 360f + 360f) % 360f
    }
}
