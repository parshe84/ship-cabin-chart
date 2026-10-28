package com.parshe84.gpssender

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.bluetooth.BluetoothManager
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.Executors

/** Foreground service: reads GPS and broadcasts NMEA sentences over UDP to the cabin computer. */
class GpsSenderService : Service(), LocationListener {

    data class State(
        val running: Boolean = false,
        val target: String = "",
        val lastLocation: Location? = null,
        val satellites: Int = 0,
        val packetsSent: Long = 0,
        val error: String? = null,
        val pressureHpa: Float? = null,
        val headingTrue: Float? = null,
        val hasBarometer: Boolean = false,
        val hasCompass: Boolean = false,
        val sats: List<Satellite> = emptyList(),
        val wifi: Boolean = true,
        val bluetooth: Boolean = false,
        val btClients: List<String> = emptyList(),
        val btError: String? = null,
        val lastSentence: String? = null,
        val fixTime: Long = 0,
    )

    companion object {
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_WIFI = "wifi"
        const val EXTRA_BLUETOOTH = "bluetooth"
        private const val CHANNEL_ID = "gps_sender"
        private const val NOTIFICATION_ID = 1

        private val _state = MutableStateFlow(State())
        val state: StateFlow<State> = _state
    }

    private val sender = Executors.newSingleThreadExecutor()
    private var socket: DatagramSocket? = null
    private var address: InetAddress? = null
    private var port = 10110
    private var satellitesUsed = 0
    @Volatile private var satellites: List<Satellite> = emptyList()
    private var wifiOn = true
    private var bt: BluetoothNmeaServer? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private lateinit var locationManager: LocationManager
    private lateinit var sensors: ShipSensors
    private val ticker = Handler(Looper.getMainLooper())
    private var ticks = 0L

    // Heading every second, pressure every 10 seconds.
    private val tick = object : Runnable {
        override fun run() {
            ticks++
            val sb = StringBuilder()
            sensors.headingTrue?.let { sb.append(NmeaBuilder.hdt(it)).append("\r\n") }
            NmeaBuilder.gsv(satellites).forEach { sb.append(it).append("\r\n") }
            if (ticks % 10 == 1L) sensors.pressureHpa?.let { sb.append(NmeaBuilder.xdrPressure(it)).append("\r\n") }
            if (sb.isNotEmpty()) send(sb.toString(), null)
            _state.value = _state.value.copy(pressureHpa = sensors.pressureHpa, headingTrue = sensors.headingTrue)
            ticker.postDelayed(this, 1000)
        }
    }

    private val gnssCallback = object : GnssStatus.Callback() {
        override fun onSatelliteStatusChanged(status: GnssStatus) {
            val sats = Satellites.from(status)
            satellites = sats
            satellitesUsed = sats.count { it.used }
            _state.value = _state.value.copy(satellites = satellitesUsed, sats = sats)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        sensors = ShipSensors(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val host = intent?.getStringExtra(EXTRA_HOST) ?: "255.255.255.255"
        port = intent?.getIntExtra(EXTRA_PORT, 10110) ?: 10110
        wifiOn = intent?.getBooleanExtra(EXTRA_WIFI, true) ?: true
        val bluetoothOn = intent?.getBooleanExtra(EXTRA_BLUETOOTH, false) ?: false

        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, buildNotification(getString(R.string.notification_text, listOfNotNull(
                "$host:$port".takeIf { wifiOn }, "Bluetooth".takeIf { bluetoothOn },
            ).joinToString(" + "))),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0,
        )

        acquireLocks()
        _state.value = State(
            running = true,
            target = if (wifiOn) "$host:$port" else "",
            hasBarometer = sensors.hasBarometer,
            hasCompass = sensors.hasCompass,
            sats = satellites,
            satellites = satellitesUsed,
            wifi = wifiOn,
            bluetooth = bluetoothOn,
        )

        sender.execute {
            socket?.close()
            socket = null
            address = null
            if (!wifiOn) return@execute
            try {
                address = InetAddress.getByName(host)
                socket = DatagramSocket().apply { broadcast = true }
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = getString(R.string.error_network, e.message))
            }
        }
        if (bluetoothOn) startBluetooth() else stopBluetooth()

        startGps()
        sensors.start()
        ticker.removeCallbacks(tick)
        ticker.post(tick)
        return START_REDELIVER_INTENT
    }

    private fun startBluetooth() {
        if (bt != null) return
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        val error = when {
            adapter == null -> getString(R.string.bt_none)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED ->
                getString(R.string.bt_no_permission)
            !adapter.isEnabled -> getString(R.string.bt_off)
            else -> null
        }
        if (error != null || adapter == null) {
            _state.value = _state.value.copy(btError = error)
            return
        }
        bt = BluetoothNmeaServer(adapter) { names -> _state.value = _state.value.copy(btClients = names) }.also { it.start() }
        _state.value = _state.value.copy(btError = null)
    }

    private fun stopBluetooth() {
        bt?.stop()
        bt = null
        _state.value = _state.value.copy(btClients = emptyList())
    }

    @SuppressLint("MissingPermission")
    private fun startGps() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            _state.value = _state.value.copy(error = getString(R.string.error_no_permission))
            stopSelf()
            return
        }
        locationManager.removeUpdates(this)
        locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper())
        locationManager.registerGnssStatusCallback(gnssCallback, Handler(Looper.getMainLooper()))
    }

    override fun onLocationChanged(location: Location) {
        val fix = NmeaBuilder.Fix(
            timeMillis = location.time,
            latitude = location.latitude,
            longitude = location.longitude,
            speedMps = if (location.hasSpeed()) location.speed else null,
            bearing = if (location.hasBearing()) location.bearing else null,
            altitude = if (location.hasAltitude()) location.altitude else null,
            satellites = satellitesUsed,
            accuracyMeters = if (location.hasAccuracy()) location.accuracy else null,
        )
        sensors.updateLocation(location)
        val nmea = NmeaBuilder.build(fix)
        _state.value = _state.value.copy(lastSentence = nmea.lineSequence().first(), fixTime = System.currentTimeMillis())
        send(nmea, location)
    }

    private fun send(text: String, location: Location?) {
        val data = text.toByteArray(Charsets.US_ASCII)
        sender.execute {
            bt?.send(data)
            val s = socket
            val a = address
            if (s == null || a == null) {
                val btSent = (bt?.clientCount ?: 0) > 0
                _state.value = _state.value.copy(
                    lastLocation = location ?: _state.value.lastLocation,
                    packetsSent = _state.value.packetsSent + if (btSent) 1 else 0,
                )
                return@execute
            }
            try {
                s.send(DatagramPacket(data, data.size, a, port))
                _state.value = _state.value.copy(
                    lastLocation = location ?: _state.value.lastLocation,
                    packetsSent = _state.value.packetsSent + 1,
                    error = null,
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = getString(R.string.error_send, e.message))
            }
        }
    }

    @Deprecated("Required for API < 29")
    override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) = Unit

    override fun onProviderDisabled(provider: String) {
        _state.value = _state.value.copy(error = getString(R.string.error_gps_off))
    }

    override fun onProviderEnabled(provider: String) {
        _state.value = _state.value.copy(error = null)
    }

    private fun acquireLocks() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GpsSender::gps").apply { acquire() }
        }
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wm.createWifiLock(mode, "GpsSender::wifi").apply { acquire() }
        }
    }

    private fun buildNotification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_ship)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        ticker.removeCallbacks(tick)
        stopBluetooth()
        sensors.stop()
        locationManager.removeUpdates(this)
        locationManager.unregisterGnssStatusCallback(gnssCallback)
        sender.execute { socket?.close() }
        sender.shutdown()
        wakeLock?.release()
        wifiLock?.release()
        _state.value = _state.value.copy(running = false)
        super.onDestroy()
    }
}
