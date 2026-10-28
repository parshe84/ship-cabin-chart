package com.parshe84.gpssender

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.abs

class MainActivity : AppCompatActivity() {

    private val prefs by lazy { getSharedPreferences("settings", Context.MODE_PRIVATE) }

    private lateinit var hostInput: EditText
    private lateinit var portInput: EditText
    private lateinit var keepScreenOn: CompoundButton
    private lateinit var wifiSwitch: CompoundButton
    private lateinit var btSwitch: CompoundButton
    private lateinit var toggleButton: Button
    private lateinit var statusText: TextView
    private lateinit var statusPill: TextView
    private lateinit var positionText: TextView
    private lateinit var fixInfo: TextView
    private lateinit var sensorsText: TextView
    private lateinit var nmeaText: TextView
    private lateinit var satCount: TextView
    private lateinit var satCaption: TextView
    private lateinit var sky: SkyView
    private lateinit var bars: SignalBarsView
    private lateinit var systems: LinearLayout
    private lateinit var btStatus: TextView
    private lateinit var banner: View
    private lateinit var bannerText: TextView
    private lateinit var bannerAction: Button

    // QR from the laptop's Setup dialog: cabingps://connect?host=192.168.1.20&port=10110
    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val uri = Uri.parse(text)
        val host = uri.getQueryParameter("host")
        val port = uri.getQueryParameter("port")?.toIntOrNull()
        val ipv4 = Regex("^(\\d{1,3}\\.){3}\\d{1,3}$")
        if (uri.scheme != "cabingps" || host == null || !ipv4.matches(host) || port == null || port !in 1..65535) {
            Toast.makeText(this, R.string.scan_bad, Toast.LENGTH_LONG).show()
            return@registerForActivityResult
        }
        hostInput.setText(host)
        portInput.setText(port.toString())
        wifiSwitch.isChecked = true
        prefs.edit().putString("host", host).putInt("port", port).apply()
        Toast.makeText(this, getString(R.string.scan_ok, host, port), Toast.LENGTH_LONG).show()
        // Start sending, or re-target the running service: a new start command switches the address.
        requestPermissionsAndStart()
    }

    private var startAfterPermission = false

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            prefs.edit().putBoolean("asked_location", true).apply()
            updateBanner()
            if (result[Manifest.permission.ACCESS_FINE_LOCATION] == true || hasLocationPermission()) {
                if (startAfterPermission) startSender()
            } else if (startAfterPermission) {
                Toast.makeText(this, R.string.need_location, Toast.LENGTH_LONG).show()
            }
            startAfterPermission = false
        }

    private val btPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result.values.all { it }) restartIfRunning() else {
                btSwitch.isChecked = false
                Toast.makeText(this, R.string.need_bt, Toast.LENGTH_LONG).show()
            }
            updateBanner()
        }

    private val discoverableLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        updateBanner()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        hostInput = findViewById(R.id.host)
        portInput = findViewById(R.id.port)
        keepScreenOn = findViewById(R.id.keep_screen_on)
        wifiSwitch = findViewById(R.id.wifi)
        btSwitch = findViewById(R.id.bluetooth)
        toggleButton = findViewById(R.id.toggle)
        statusText = findViewById(R.id.status)
        statusPill = findViewById(R.id.status_pill)
        positionText = findViewById(R.id.position)
        fixInfo = findViewById(R.id.fix_info)
        sensorsText = findViewById(R.id.sensors)
        nmeaText = findViewById(R.id.nmea)
        satCount = findViewById(R.id.sat_count)
        satCaption = findViewById(R.id.sat_caption)
        sky = findViewById(R.id.sky)
        bars = findViewById(R.id.bars)
        systems = findViewById(R.id.systems)
        btStatus = findViewById(R.id.bt_status)
        banner = findViewById(R.id.banner)
        bannerText = findViewById(R.id.banner_text)
        bannerAction = findViewById(R.id.banner_action)

        findViewById<Button>(R.id.scan).setOnClickListener {
            scanLauncher.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt(getString(R.string.scan_prompt))
                    .setBeepEnabled(false)
                    .setOrientationLocked(true),
            )
        }
        findViewById<Button>(R.id.bt_visible).setOnClickListener { makeDiscoverable() }

        hostInput.setText(prefs.getString("host", "255.255.255.255"))
        portInput.setText(prefs.getInt("port", 10110).toString())
        keepScreenOn.isChecked = prefs.getBoolean("keep_screen_on", false)
        wifiSwitch.isChecked = prefs.getBoolean("wifi", true)
        btSwitch.isChecked = prefs.getBoolean("bluetooth", false)
        applyKeepScreenOn()
        applyTransportVisibility()

        keepScreenOn.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("keep_screen_on", checked).apply()
            applyKeepScreenOn()
        }
        wifiSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("wifi", checked).apply()
            applyTransportVisibility()
            restartIfRunning()
        }
        btSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("bluetooth", checked).apply()
            applyTransportVisibility()
            if (checked && missingBtPermissions().isNotEmpty()) {
                btPermissionLauncher.launch(missingBtPermissions().toTypedArray())
            } else {
                restartIfRunning()
            }
            updateBanner()
        }

        toggleButton.setOnClickListener {
            if (GpsSenderService.state.value.running) {
                stopService(Intent(this, GpsSenderService::class.java))
            } else {
                requestPermissionsAndStart()
            }
        }

        // Ask for location right away on the first launch, so the satellites can be read.
        if (!hasLocationPermission() && !prefs.getBoolean("asked_location", false)) {
            permissionLauncher.launch(locationPermissions().toTypedArray())
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                GpsSenderService.state.collect(::render)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        updateBanner()
    }

    private fun applyKeepScreenOn() {
        if (keepScreenOn.isChecked) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun applyTransportVisibility() {
        findViewById<View>(R.id.wifi_box).visibility = if (wifiSwitch.isChecked) View.VISIBLE else View.GONE
        findViewById<View>(R.id.bt_box).visibility = if (btSwitch.isChecked) View.VISIBLE else View.GONE
    }

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun locationPermissions(): List<String> {
        val list = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) list += Manifest.permission.POST_NOTIFICATIONS
        return list
    }

    private fun missingBtPermissions(): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return emptyList()
        return listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
    }

    private fun bluetoothAdapter(): BluetoothAdapter? = getSystemService(BluetoothManager::class.java)?.adapter

    private fun locationEnabled(): Boolean =
        LocationManagerCompat.isLocationEnabled(getSystemService(Context.LOCATION_SERVICE) as LocationManager)

    /** One banner at a time: missing permission, location off, Bluetooth off. */
    private fun updateBanner() {
        val canAskAgain = !prefs.getBoolean("asked_location", false) ||
            ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.ACCESS_FINE_LOCATION)
        when {
            !hasLocationPermission() && canAskAgain -> showBanner(R.string.banner_permission, R.string.action_allow) {
                permissionLauncher.launch(locationPermissions().toTypedArray())
            }
            !hasLocationPermission() -> showBanner(R.string.banner_permission_settings, R.string.action_settings) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            }
            !locationEnabled() -> showBanner(R.string.banner_location_off, R.string.action_turn_on) {
                startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
            }
            btSwitch.isChecked && bluetoothAdapter()?.isEnabled == false -> showBanner(R.string.banner_bt_off, R.string.action_turn_on) {
                startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
            }
            else -> banner.visibility = View.GONE
        }
    }

    private fun showBanner(text: Int, action: Int, onClick: () -> Unit) {
        bannerText.setText(text)
        bannerAction.setText(action)
        bannerAction.setOnClickListener { onClick() }
        banner.visibility = View.VISIBLE
    }

    @SuppressLint("MissingPermission") // BLUETOOTH_ADVERTISE is checked just above
    private fun makeDiscoverable() {
        val missing = missingBtPermissions()
        if (missing.isNotEmpty()) {
            btPermissionLauncher.launch(missing.toTypedArray())
            return
        }
        try {
            discoverableLauncher.launch(
                Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 300),
            )
        } catch (e: SecurityException) {
            startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
        }
    }

    private fun requestPermissionsAndStart() {
        val missingBt = if (btSwitch.isChecked) missingBtPermissions() else emptyList()
        val missing = locationPermissions().filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        } + missingBt
        when {
            hasLocationPermission() && missingBt.isEmpty() -> startSender()
            !hasLocationPermission() && prefs.getBoolean("asked_location", false) &&
                !ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.ACCESS_FINE_LOCATION) -> {
                // Denied for good: Android will not show the dialog again, so point to the app settings.
                updateBanner()
                Toast.makeText(this, R.string.banner_permission_settings, Toast.LENGTH_LONG).show()
            }
            else -> {
                startAfterPermission = true
                permissionLauncher.launch(missing.toTypedArray())
            }
        }
    }

    private fun restartIfRunning() {
        if (GpsSenderService.state.value.running) startSender()
    }

    private fun startSender() {
        if (!wifiSwitch.isChecked && !btSwitch.isChecked) wifiSwitch.isChecked = true
        val host = hostInput.text.toString().trim().ifEmpty { "255.255.255.255" }
        val port = portInput.text.toString().toIntOrNull()?.takeIf { it in 1..65535 } ?: 10110
        prefs.edit().putString("host", host).putInt("port", port).apply()

        val intent = Intent(this, GpsSenderService::class.java)
            .putExtra(GpsSenderService.EXTRA_HOST, host)
            .putExtra(GpsSenderService.EXTRA_PORT, port)
            .putExtra(GpsSenderService.EXTRA_WIFI, wifiSwitch.isChecked)
            .putExtra(GpsSenderService.EXTRA_BLUETOOTH, btSwitch.isChecked)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun render(s: GpsSenderService.State) {
        toggleButton.setText(if (s.running) R.string.stop else R.string.start)
        hostInput.isEnabled = !s.running
        portInput.isEnabled = !s.running

        val fixFresh = s.lastLocation != null && System.currentTimeMillis() - s.fixTime < 5000
        statusPill.setText(
            when {
                !s.running -> R.string.pill_off
                fixFresh -> R.string.pill_fix
                else -> R.string.pill_search
            },
        )
        statusPill.setTextColor(
            ContextCompat.getColor(this, if (fixFresh) R.color.neon_cyan else if (s.running) R.color.neon_pink else R.color.muted),
        )

        statusText.text = when {
            s.error != null -> s.error
            !s.running -> getString(R.string.stopped)
            s.lastLocation == null -> getString(R.string.waiting_fix, s.target.ifEmpty { "Bluetooth" }, s.satellites)
            !s.wifi -> getString(R.string.sending_bt, s.packetsSent)
            else -> getString(R.string.sending, s.target, s.packetsSent, s.satellites)
        }

        renderSatellites(s)

        val loc = s.lastLocation
        positionText.text = if (loc == null) "—" else buildString {
            appendLine(ddm(loc.latitude, 'N', 'S'))
            append(ddm(loc.longitude, 'E', 'W'))
        }
        fixInfo.text = if (loc == null) "" else buildString {
            if (loc.hasSpeed()) append(String.format(Locale.US, "SOG %.1f kn   ", loc.speed * 1.943844))
            if (loc.hasBearing()) append(String.format(Locale.US, "COG %03.0f°   ", loc.bearing))
            if (loc.hasAccuracy()) {
                val age = ((System.currentTimeMillis() - s.fixTime) / 1000).coerceAtLeast(0)
                append(getString(R.string.fix_info, loc.accuracy, "${age}s"))
            }
        }

        val parts = mutableListOf<String>()
        s.pressureHpa?.let { parts += getString(R.string.sensor_pressure, it) }
        s.headingTrue?.let { parts += getString(R.string.sensor_heading, it) }
        sensorsText.text = when {
            parts.isNotEmpty() -> parts.joinToString("  ·  ")
            s.running && !s.hasBarometer && !s.hasCompass -> getString(R.string.sensors_none)
            else -> ""
        }
        nmeaText.text = s.lastSentence?.let { getString(R.string.last_nmea, it) } ?: ""

        btStatus.text = when {
            !s.running -> ""
            s.btError != null -> s.btError
            s.btClients.isEmpty() -> getString(R.string.bt_waiting)
            else -> getString(R.string.bt_connected, s.btClients.joinToString(", "))
        }
    }

    private fun renderSatellites(s: GpsSenderService.State) {
        val sats = if (s.running) s.sats else emptyList()
        sky.satellites = sats
        bars.satellites = sats
        val summary = Satellites.summary(sats)
        satCount.text = if (s.running) "${sats.count { it.used }} / ${sats.size}" else "—"
        satCaption.text = when {
            !s.running -> getString(R.string.sat_caption_off)
            sats.isEmpty() -> getString(R.string.sat_searching)
            else -> getString(R.string.sat_caption, summary.size)
        }
        systems.removeAllViews()
        for ((sys, used, inView) in summary) systems.addView(systemRow(sys, used, inView))
    }

    /** "● GLONASS ▮▮▮▮▮▯▯  6 / 8" */
    private fun systemRow(sys: GnssSystem, used: Int, inView: Int): View {
        val dp = resources.displayMetrics.density
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, (3 * dp).toInt(), 0, (3 * dp).toInt())
        }
        val dot = View(this).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(sys.color) }
        }
        row.addView(dot, LinearLayout.LayoutParams((9 * dp).toInt(), (9 * dp).toInt()))
        row.addView(TextView(this).apply {
            text = sys.label
            setTextColor(ContextCompat.getColor(context, R.color.text))
            textSize = 14f
            setPadding((8 * dp).toInt(), 0, 0, 0)
        }, LinearLayout.LayoutParams((96 * dp).toInt(), LinearLayout.LayoutParams.WRAP_CONTENT))
        // Bar: used part solid, tracked part dim.
        val track = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val usedBar = View(this).apply {
            background = GradientDrawable().apply { cornerRadius = 4 * dp; setColor(sys.color) }
        }
        val restBar = View(this).apply {
            background = GradientDrawable().apply { cornerRadius = 4 * dp; setColor(sys.color and 0x00FFFFFF or (0x40 shl 24)) }
        }
        track.addView(usedBar, LinearLayout.LayoutParams(0, (8 * dp).toInt(), used.toFloat().coerceAtLeast(0.001f)))
        track.addView(restBar, LinearLayout.LayoutParams(0, (8 * dp).toInt(), (inView - used).toFloat().coerceAtLeast(0.001f)))
        row.addView(track, LinearLayout.LayoutParams(0, (8 * dp).toInt(), 1f))
        row.addView(TextView(this).apply {
            text = String.format(Locale.US, "%2d / %-2d", used, inView)
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(sys.color)
            textSize = 14f
            gravity = Gravity.END
        }, LinearLayout.LayoutParams((72 * dp).toInt(), LinearLayout.LayoutParams.WRAP_CONTENT))
        return row
    }

    private fun ddm(value: Double, pos: Char, neg: Char): String {
        val a = abs(value)
        val deg = a.toInt()
        val min = (a - deg) * 60
        return String.format(Locale.US, "%d° %06.3f′ %c", deg, min, if (value >= 0) pos else neg)
    }
}
