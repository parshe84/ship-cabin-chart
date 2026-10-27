package com.parshe84.gpssender

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.floor

/** Builds NMEA 0183 sentences (RMC, GGA, VTG) from a position fix. */
object NmeaBuilder {

    private const val MPS_TO_KNOTS = 1.943844

    data class Fix(
        val timeMillis: Long,
        val latitude: Double,
        val longitude: Double,
        val speedMps: Float?,
        val bearing: Float?,
        val altitude: Double?,
        val satellites: Int,
        val accuracyMeters: Float?,
    )

    fun build(fix: Fix): String = buildString {
        append(rmc(fix)).append("\r\n")
        append(gga(fix)).append("\r\n")
        append(vtg(fix)).append("\r\n")
    }

    fun rmc(fix: Fix): String {
        val (time, date) = utc(fix.timeMillis)
        val sog = fix.speedMps?.let { fmt("%.1f", it * MPS_TO_KNOTS) } ?: ""
        val cog = fix.bearing?.let { fmt("%.1f", it) } ?: ""
        return sentence(
            "GPRMC,$time,A,${lat(fix.latitude)},${lon(fix.longitude)},$sog,$cog,$date,,,A"
        )
    }

    fun gga(fix: Fix): String {
        val (time, _) = utc(fix.timeMillis)
        // Rough HDOP estimate from horizontal accuracy (~5 m per HDOP unit for phones).
        val hdop = fix.accuracyMeters?.let { fmt("%.1f", (it / 5f).coerceAtLeast(0.5f)) } ?: ""
        val alt = fix.altitude?.let { fmt("%.1f", it) } ?: ""
        val sats = String.format(Locale.US, "%02d", fix.satellites.coerceIn(0, 99))
        return sentence(
            "GPGGA,$time,${lat(fix.latitude)},${lon(fix.longitude)},1,$sats,$hdop,$alt,M,,M,,"
        )
    }

    fun vtg(fix: Fix): String {
        val cog = fix.bearing?.let { fmt("%.1f", it) } ?: ""
        val kn = fix.speedMps?.let { fmt("%.1f", it * MPS_TO_KNOTS) } ?: ""
        val kmh = fix.speedMps?.let { fmt("%.1f", it * 3.6) } ?: ""
        return sentence("GPVTG,$cog,T,,M,$kn,N,$kmh,K,A")
    }

    /** Barometric pressure as a transducer reading, in bar (1013.25 hPa -> 1.01325). */
    fun xdrPressure(hPa: Float): String =
        sentence("IIXDR,P,${fmt("%.5f", hPa.toDouble() / 1000.0)},B,Barometer")

    /** True heading. */
    fun hdt(headingTrue: Float): String =
        sentence("HCHDT,${fmt("%.1f", ((headingTrue % 360f) + 360f) % 360f)},T")

    fun checksum(body: String): String {
        var sum = 0
        for (c in body) sum = sum xor c.code
        return String.format(Locale.US, "%02X", sum)
    }

    private fun sentence(body: String) = "$$body*${checksum(body)}"

    private fun lat(value: Double): String {
        val (deg, min) = degMin(value)
        return String.format(Locale.US, "%02d%07.4f,%s", deg, min, if (value >= 0) "N" else "S")
    }

    private fun lon(value: Double): String {
        val (deg, min) = degMin(value)
        return String.format(Locale.US, "%03d%07.4f,%s", deg, min, if (value >= 0) "E" else "W")
    }

    private fun degMin(value: Double): Pair<Int, Double> {
        val a = abs(value)
        var deg = floor(a).toInt()
        var min = (a - deg) * 60.0
        // Avoid "60.0000" minutes after rounding.
        if (min >= 59.99995) {
            deg += 1
            min = 0.0
        }
        return deg to min
    }

    private fun utc(millis: Long): Pair<String, String> {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = millis }
        val time = String.format(
            Locale.US, "%02d%02d%02d.%02d",
            c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), c.get(Calendar.SECOND),
            c.get(Calendar.MILLISECOND) / 10,
        )
        val date = String.format(
            Locale.US, "%02d%02d%02d",
            c.get(Calendar.DAY_OF_MONTH), c.get(Calendar.MONTH) + 1, c.get(Calendar.YEAR) % 100,
        )
        return time to date
    }

    private fun fmt(pattern: String, value: Number) = String.format(Locale.US, pattern, value)
}
