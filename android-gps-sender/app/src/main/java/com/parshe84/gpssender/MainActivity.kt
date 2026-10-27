package com.parshe84.gpssender

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
    }

    private fun ddm(value: Double, pos: Char, neg: Char): String {
        val a = abs(value)
        val deg = a.toInt()
        val min = (a - deg) * 60
        return String.format(Locale.US, "%d° %06.3f′ %c", deg, min, if (value >= 0) pos else neg)
    }
}
