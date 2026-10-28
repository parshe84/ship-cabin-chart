package com.parshe84.gpssender

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NmeaBuilderTest {

    private val fix = NmeaBuilder.Fix(
        timeMillis = 1793089815000L, // 2026-10-27T08:30:15Z
        latitude = 59.968667,
        longitude = -30.21,
        speedMps = 2.83f,
        bearing = 270f,
        altitude = 12.0,
        satellites = 9,
        accuracyMeters = 4f,
    )

    @Test
    fun checksumMatchesReferenceSentence() {
        assertEquals(
            "6A",
            NmeaBuilder.checksum("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W"),
        )
    }

    @Test
    fun rmcContainsPositionSpeedAndDate() {
        val rmc = NmeaBuilder.rmc(fix)
        assertTrue(rmc, rmc.startsWith("\$GPRMC,083015.00,A,5958.1200,N,03012.6000,W,5.5,270.0,271026,"))
        val body = rmc.substring(1, rmc.indexOf('*'))
        assertEquals(NmeaBuilder.checksum(body), rmc.substringAfter('*'))
    }

    @Test
    fun ggaReportsSatellites() {
        val gga = NmeaBuilder.gga(fix)
        assertTrue(gga, gga.contains(",1,09,0.8,12.0,M,"))
    }

    @Test
    fun pressureIsSentInBar() {
        val xdr = NmeaBuilder.xdrPressure(1013.25f)
        assertTrue(xdr, xdr.startsWith("\$IIXDR,P,1.01325,B,Barometer*"))
        assertEquals(NmeaBuilder.checksum(xdr.substring(1, xdr.indexOf('*'))), xdr.substringAfter('*'))
    }

    @Test
    fun headingIsNormalised() {
        assertTrue(NmeaBuilder.hdt(-10f).startsWith("\$HCHDT,350.0,T*"))
        assertTrue(NmeaBuilder.hdt(370f).startsWith("\$HCHDT,10.0,T*"))
    }

    @Test
    fun northEastPositionKeepsHemispheres() {
        // Zaporizhzhia: 47.8388 N, 35.1396 E
        val ne = fix.copy(latitude = 47.8388, longitude = 35.1396)
        val rmc = NmeaBuilder.rmc(ne)
        assertTrue(rmc, rmc.contains(",4750.3280,N,03508.3760,E,"))
        val gga = NmeaBuilder.gga(ne)
        assertTrue(gga, gga.contains(",4750.3280,N,03508.3760,E,"))
    }

    @Test
    fun gsvGroupsSatellitesBySystem() {
        val sats = listOf(
            Satellite(GnssSystem.GPS, 5, 41.5f, 63f, 120f, true),
            Satellite(GnssSystem.GPS, 12, 30f, 20f, 300f, false),
            Satellite(GnssSystem.GLONASS, 7, 35f, 45f, 10f, true),
            Satellite(GnssSystem.GALILEO, 3, 0f, 5f, 200f, false),
            Satellite(GnssSystem.GLONASS, 100, 20f, 10f, 10f, false), // unknown slot: skipped
        )
        val gsv = NmeaBuilder.gsv(sats)
        assertEquals(3, gsv.size)
        assertTrue(gsv[0], gsv[0].startsWith("\$GPGSV,1,1,02,05,63,120,41,12,20,300,30*"))
        assertTrue(gsv[1], gsv[1].startsWith("\$GLGSV,1,1,01,71,45,010,35*"))
        assertTrue(gsv[2], gsv[2].startsWith("\$GAGSV,1,1,01,03,05,200,*"))
    }

    @Test
    fun gsvSplitsIntoSentencesOfFour() {
        val sats = (1..9).map { Satellite(GnssSystem.BEIDOU, it, 30f, 30f, 30f, true) }
        val gsv = NmeaBuilder.gsv(sats)
        assertEquals(3, gsv.size)
        assertTrue(gsv[2], gsv[2].startsWith("\$GBGSV,3,3,09,09,30,030,30*"))
    }
}
