package com.parshe84.gpssender

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
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
    private lateinit var toggleButton: Button
    private lateinit var statusText: TextView
    private lateinit var positionText: TextView
    private lateinit var sensorsText: TextView

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
        prefs.edit().putString("host", host).putInt("port", port).apply()
        Toast.makeText(this, getString(R.string.scan_ok, host, port), Toast.LENGTH_LONG).show()
        // Start sending, or re-target the running service: a new start command switches the address.
        requestPermissionsAndStart()
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
                startSender()
            } else {
                Toast.makeText(this, R.string.need_location, Toast.LENGTH_LONG).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        hostInput = findViewById(R.id.host)
        portInput = findViewById(R.id.port)
        keepScreenOn = findViewById(R.id.keep_screen_on)
        toggleButton = findViewById(R.id.toggle)
        statusText = findViewById(R.id.status)
        positionText = findViewById(R.id.position)
        sensorsText = findViewById(R.id.sensors)

        findViewById<Button>(R.id.scan).setOnClickListener {
            scanLauncher.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt(getString(R.string.scan_prompt))
                    .setBeepEnabled(false)
                    .setOrientationLocked(true),
            )
        }

        hostInput.setText(prefs.getString("host", "255.255.255.255"))
        portInput.setText(prefs.getInt("port", 10110).toString())
        keepScreenOn.isChecked = prefs.getBoolean("keep_screen_on", false)
        applyKeepScreenOn()

        keepScreenOn.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("keep_screen_on", checked).apply()
            applyKeepScreenOn()
        }

        toggleButton.setOnClickListener {
            if (GpsSenderService.state.value.running) {
                stopService(Intent(this, GpsSenderService::class.java))
            } else {
                requestPermissionsAndStart()
            }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                GpsSenderService.state.collect(::render)
            }
        }
    }

    private fun applyKeepScreenOn() {
        if (keepScreenOn.isChecked) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun requestPermissionsAndStart() {
        val needed = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) startSender() else permissionLauncher.launch(missing.toTypedArray())
    }

    private fun startSender() {
        val host = hostInput.text.toString().trim().ifEmpty { "255.255.255.255" }
        val port = portInput.text.toString().toIntOrNull()?.takeIf { it in 1..65535 } ?: 10110
        prefs.edit().putString("host", host).putInt("port", port).apply()

        val intent = Intent(this, GpsSenderService::class.java)
            .putExtra(GpsSenderService.EXTRA_HOST, host)
            .putExtra(GpsSenderService.EXTRA_PORT, port)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun render(s: GpsSenderService.State) {
        toggleButton.setText(if (s.running) R.string.stop else R.string.start)
        hostInput.isEnabled = !s.running
        portInput.isEnabled = !s.running

        statusText.text = when {
            s.error != null -> s.error
            !s.running -> getString(R.string.stopped)
            s.lastLocation == null -> getString(R.string.waiting_fix, s.target, s.satellites)
            else -> getString(R.string.sending, s.target, s.packetsSent, s.satellites)
        }

        val loc = s.lastLocation
        positionText.text = if (loc == null) "—" else buildString {
            appendLine(ddm(loc.latitude, 'N', 'S'))
            appendLine(ddm(loc.longitude, 'E', 'W'))
            if (loc.hasSpeed()) append(String.format(Locale.US, "%.1f kn  ", loc.speed * 1.943844))
            if (loc.hasBearing()) append(String.format(Locale.US, "%03.0f°  ", loc.bearing))
            if (loc.hasAccuracy()) append(String.format(Locale.US, "±%.0f m", loc.accuracy))
        }

        val parts = mutableListOf<String>()
        s.pressureHpa?.let { parts += getString(R.string.sensor_pressure, it) }
        s.headingTrue?.let { parts += getString(R.string.sensor_heading, it) }
        sensorsText.text = when {
            parts.isNotEmpty() -> parts.joinToString("  ·  ")
            s.running && !s.hasBarometer && !s.hasCompass -> getString(R.string.sensors_none)
            else -> ""
        }
    }

    private fun ddm(value: Double, pos: Char, neg: Char): String {
        val a = abs(value)
        val deg = a.toInt()
        val min = (a - deg) * 60
        return String.format(Locale.US, "%d° %06.3f′ %c", deg, min, if (value >= 0) pos else neg)
    }
}
