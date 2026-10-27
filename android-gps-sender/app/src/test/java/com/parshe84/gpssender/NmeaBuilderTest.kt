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
}
