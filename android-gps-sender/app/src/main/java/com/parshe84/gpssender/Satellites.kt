package com.parshe84.gpssender

import android.location.GnssStatus
import android.os.Build

/** One satellite from GnssStatus, independent of Android classes so it can be unit tested. */
data class Satellite(
    val system: GnssSystem,
    val svid: Int,
    val cn0: Float,
    val elevation: Float,
    val azimuth: Float,
    val used: Boolean,
    val dualBand: Boolean = false,
)

/**
 * Satellite systems as reported by Android. The phone tracks every system its GNSS chip supports
 * (GPS/NAVSTAR, GLONASS, Galileo, BeiDou, QZSS, NavIC, SBAS) automatically.
 * [talker] is the NMEA 0183 talker id for GSV sentences.
 */
enum class GnssSystem(val label: String, val color: Int, val talker: String) {
    GPS("GPS", 0xFF00E5FF.toInt(), "GP"),
    GLONASS("GLONASS", 0xFFFF2BD6.toInt(), "GL"),
    GALILEO("Galileo", 0xFF39FF88.toInt(), "GA"),
    BEIDOU("BeiDou", 0xFFFFD23F.toInt(), "GB"),
    QZSS("QZSS", 0xFFFF8A3D.toInt(), "GQ"),
    NAVIC("NavIC", 0xFFB388FF.toInt(), "GI"),
    SBAS("SBAS", 0xFF8FA3B8.toInt(), "GP"),
    OTHER("Other", 0xFF6F8AA6.toInt(), "GN");

    companion object {
        fun of(constellation: Int): GnssSystem = when (constellation) {
            GnssStatus.CONSTELLATION_GPS -> GPS
            GnssStatus.CONSTELLATION_GLONASS -> GLONASS
            GnssStatus.CONSTELLATION_GALILEO -> GALILEO
            GnssStatus.CONSTELLATION_BEIDOU -> BEIDOU
            GnssStatus.CONSTELLATION_QZSS -> QZSS
            GnssStatus.CONSTELLATION_SBAS -> SBAS
            9 -> NAVIC // GnssStatus.CONSTELLATION_IRNSS (API 29)
            else -> OTHER
        }
    }
}

object Satellites {
    fun from(status: GnssStatus): List<Satellite> = (0 until status.satelliteCount).map { i ->
        val dual = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && status.hasCarrierFrequencyHz(i) &&
            status.getCarrierFrequencyHz(i) < 1.3e9f // L5 / E5a / B2a
        Satellite(
            system = GnssSystem.of(status.getConstellationType(i)),
            svid = status.getSvid(i),
            cn0 = status.getCn0DbHz(i),
            elevation = status.getElevationDegrees(i),
            azimuth = status.getAzimuthDegrees(i),
            used = status.usedInFix(i),
            dualBand = dual,
        )
    }

    /** Per system: (used, in view), only systems that are in view, in enum order. */
    fun summary(sats: List<Satellite>): List<Triple<GnssSystem, Int, Int>> =
        GnssSystem.entries.mapNotNull { sys ->
            val list = sats.filter { it.system == sys }
            if (list.isEmpty()) null else Triple(sys, list.count { it.used }, list.size)
        }
}
