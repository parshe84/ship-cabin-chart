package com.parshe84.gpssender

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Bluetooth Serial Port Profile server. After pairing, the computer opens the phone's "Cabin GPS"
 * serial service (on Windows: a Bluetooth COM port) and receives the same NMEA stream as over Wi-Fi.
 * Several computers can be connected at once. Permission checks are done by the caller.
 */
@SuppressLint("MissingPermission")
class BluetoothNmeaServer(
    private val adapter: BluetoothAdapter,
    private val onClientsChanged: (List<String>) -> Unit,
) {
    companion object {
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        const val SERVICE_NAME = "Cabin GPS NMEA"
    }

    private val clients = CopyOnWriteArrayList<BluetoothSocket>()
    @Volatile private var server: BluetoothServerSocket? = null
    @Volatile private var stopped = false
    private var thread: Thread? = null

    fun start() {
        if (thread != null) return
        stopped = false
        thread = Thread({ acceptLoop() }, "bt-nmea-server").apply {
            isDaemon = true
            start()
        }
    }

    private fun acceptLoop() {
        while (!stopped) {
            try {
                val ss = adapter.listenUsingRfcommWithServiceRecord(SERVICE_NAME, SPP_UUID)
                server = ss
                while (!stopped) {
                    val socket = ss.accept() ?: break
                    clients += socket
                    notifyClients()
                }
            } catch (e: IOException) {
                // Bluetooth turned off or the socket was closed: retry while running.
                server?.let { runCatching { it.close() } }
                server = null
                if (stopped) return
                try {
                    Thread.sleep(3000)
                } catch (_: InterruptedException) {
                    return
                }
            } catch (e: SecurityException) {
                return
            }
        }
    }

    /** Called on the sender thread; a client that fails to receive is dropped. */
    fun send(data: ByteArray) {
        for (c in clients) {
            try {
                c.outputStream.write(data)
                c.outputStream.flush()
            } catch (e: IOException) {
                clients.remove(c)
                runCatching { c.close() }
                notifyClients()
            }
        }
    }

    val clientCount get() = clients.size

    private fun notifyClients() {
        onClientsChanged(clients.map { runCatching { it.remoteDevice.name }.getOrNull() ?: it.remoteDevice.address })
    }

    fun stop() {
        stopped = true
        server?.let { runCatching { it.close() } }
        for (c in clients) runCatching { c.close() }
        clients.clear()
        thread?.interrupt()
        thread = null
        notifyClients()
    }
}
