package com.supershare.client

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.DocumentsContract
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.net.DatagramPacket
import java.net.DatagramSocket

class MainActivity : Activity() {
    private val pickFilesRequest = 4102
    private val saveFileRequest = 4103
    private val executor = Executors.newSingleThreadExecutor()
    private val prefs by lazy { getSharedPreferences("supershare", MODE_PRIVATE) }
    private val deviceId by lazy { prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("device_id", it).apply() } }
    private lateinit var hostInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var phraseText: TextView
    private lateinit var statusText: TextView
    private lateinit var pairButton: Button
    private lateinit var confirmButton: Button
    private var pendingUris: List<Uri> = emptyList()
    private var phrase = ""
    private var pendingDownloadPath = ""
    @Volatile private var baseHost = ""
    @Volatile private var responseCookie: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildScreen()
        handleShareIntent(intent)
        baseHost = prefs.getString("host", "") ?: ""
        hostInput.setText(baseHost)
        if (prefs.getString("phrase", null) != null) {
            phrase = prefs.getString("phrase", "") ?: ""
            phraseText.text = "Compare this phrase with the laptop: $phrase"
            confirmButton.isEnabled = true
        }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleShareIntent(intent) }

    @Deprecated("Activity result API retained to avoid adding AndroidX dependencies")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == saveFileRequest && resultCode == RESULT_OK && data != null) {
            val destination = data.data ?: return
            downloadToPhone(pendingDownloadPath, destination)
            return
        }
        if (requestCode != pickFilesRequest || resultCode != RESULT_OK || data == null) return
        val selected = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (index in 0 until clip.itemCount) selected.add(clip.getItemAt(index).uri) }
        if (selected.isEmpty()) data.data?.let(selected::add)
        if (selected.isNotEmpty()) {
            pendingUris = selected
            statusText.text = "${selected.size} file(s) selected from their original locations. Pair and approve, then send."
        }
    }

    private fun buildScreen() {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 28, 24, 20); setBackgroundColor(0xFF101113.toInt()) }
        fun label(text: String, size: Float = 16f) = TextView(this).apply { this.text = text; textSize = size; setTextColor(0xFFF4F4F5.toInt()); setPadding(0, 8, 0, 8) }
        root.addView(label("SuperShare", 24f))
        root.addView(label("Connect to your laptop hotspot. Internet is not required.", 14f))
        hostInput = EditText(this).apply { hint = "Laptop address, for example http://192.168.137.1:8765"; setSingleLine(true); setTextColor(-1); setHintTextColor(0xFF9CA3AF.toInt()) }
        root.addView(hostInput, ViewGroup.LayoutParams(-1, -2))
        codeInput = EditText(this).apply { hint = "Pairing code shown in laptop terminal"; setSingleLine(true); setTextColor(-1); setHintTextColor(0xFF9CA3AF.toInt()) }
        root.addView(codeInput, ViewGroup.LayoutParams(-1, -2))
        pairButton = Button(this).apply { text = "Pair with laptop"; setOnClickListener { pair() } }
        root.addView(pairButton)
        root.addView(Button(this).apply { text = "Find laptop on this hotspot"; setOnClickListener { discoverHost() } })
        root.addView(Button(this).apply { text = "Select files from device"; setOnClickListener { openDocumentPicker() } })
        root.addView(Button(this).apply { text = "Browse files on laptop"; setOnClickListener { browseRemoteFiles("") } })
        phraseText = label("Pairing phrase appears here after pairing.", 14f)
        root.addView(phraseText)
        confirmButton = Button(this).apply { text = "Phrase matches"; isEnabled = false; setOnClickListener { confirmPairing() } }
        root.addView(confirmButton)
        val send = Button(this).apply { text = "Send selected shared file(s)"; setOnClickListener { sendPending() } }
        root.addView(send)
        statusText = label("Ready", 14f)
        root.addView(statusText)
        setContentView(root)
    }

    private fun handleShareIntent(intent: Intent?) {
        val uris = when (intent?.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.toList().orEmpty()
            else -> emptyList()
        }
        if (uris.isNotEmpty()) {
            pendingUris = uris
            statusText.text = "${uris.size} shared item(s) ready. Pair and approve this device, then send."
        }
    }

    private fun openDocumentPicker() {
        val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivityForResult(picker, pickFilesRequest)
    }

    private fun browseRemoteFiles(path: String) = runOnNetwork("Loading laptop folder…") {
        val encodedPath = URLEncoder.encode(path, "UTF-8")
        val data = JSONObject(request("/api/list?path=$encodedPath", "GET", null))
        val items = data.getJSONArray("items")
        val labels = mutableListOf<String>()
        val paths = mutableListOf<String?>()
        val names = mutableListOf<String>()
        if (path.isNotEmpty()) { labels.add("..  (Parent folder)"); paths.add(path.substringBeforeLast('/', "")); names.add("") }
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            val name = item.getString("name")
            val childPath = if (path.isEmpty()) name else "$path/$name"
            labels.add(if (item.optBoolean("is_dir")) "$name/" else "$name · ${formatBytes(item.optLong("size"))}")
            paths.add(if (item.optBoolean("is_dir")) childPath else null)
            names.add(name)
        }
        runOnUiThread {
            AlertDialog.Builder(this).setTitle(if (path.isEmpty()) "Laptop shared files" else path)
                .setItems(labels.toTypedArray()) { _, selected ->
                    val next = paths[selected]
                    if (next != null) browseRemoteFiles(next)
                    else {
                        val selectedName = names[selected]
                        pendingDownloadPath = if (path.isEmpty()) selectedName else "$path/$selectedName"
                        val save = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "application/octet-stream"
                            putExtra(Intent.EXTRA_TITLE, selectedName)
                            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                        }
                        startActivityForResult(save, saveFileRequest)
                    }
                }.setNegativeButton("Close", null).show()
        }
    }

    private fun downloadToPhone(remoteFile: String, destination: Uri) = runOnNetwork("Receiving file from laptop…") {
        val encodedPath = URLEncoder.encode(remoteFile, "UTF-8")
        val connection = (URL("${normalizeHost()}/api/download?path=$encodedPath").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 60_000
            setRequestProperty("X-SuperShare-Device", deviceId)
            setRequestProperty("X-SuperShare-Name", android.os.Build.MODEL)
            setRequestProperty("X-SuperShare-Type", "Android")
            prefs.getString("cookie", null)?.let { setRequestProperty("Cookie", it) }
        }
        try {
            if (connection.responseCode !in 200..299) {
                val error = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                error(error.ifBlank { "Download failed (${connection.responseCode})" })
            }
            val output = contentResolver.openOutputStream(destination, "w") ?: error("Could not open the selected phone destination.")
            connection.inputStream.use { input -> output.use { sink ->
                val buffer = ByteArray(1024 * 1024)
                var total = 0L
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    sink.write(buffer, 0, count)
                    total += count
                    runOnUiThread { statusText.text = "Receiving ${remoteFile.substringAfterLast('/')} · ${formatBytes(total)}" }
                }
                sink.flush()
            } }
            runOnUiThread { statusText.text = "Saved ${remoteFile.substringAfterLast('/')} to the selected phone location." }
        } catch (error: Exception) {
            try { DocumentsContract.deleteDocument(contentResolver, destination) } catch (_: Exception) { }
            throw error
        } finally { connection.disconnect() }
    }

    private fun formatBytes(value: Long): String {
        if (value < 1024) return "$value B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var amount = value.toDouble()
        var unit = -1
        do { amount /= 1024.0; unit++ } while (amount >= 1024 && unit < units.lastIndex)
        return "%.1f %s".format(amount, units[unit])
    }

    private fun pair() {
        val host = normalizeHost()
        val code = codeInput.text.toString().trim()
        if (host.isBlank() || code.isBlank()) { statusText.text = "Enter the laptop address and pairing code."; return }
        prefs.edit().putString("host", host).apply()
        baseHost = host
        runOnNetwork("Pairing with laptop…") {
            val body = JSONObject().put("code", code).put("id", deviceId).put("name", android.os.Build.MODEL).put("type", "Android")
            val response = request("/api/pair", "POST", body.toString())
            val cookie = responseCookie ?: error("Pairing credential was not returned")
            val result = JSONObject(response)
            prefs.edit().putString("cookie", cookie).putString("phrase", result.getString("verification_phrase")).apply()
            phrase = result.getString("verification_phrase")
            runOnUiThread { phraseText.text = "Compare this phrase with the laptop: $phrase"; confirmButton.isEnabled = true; statusText.text = "Paired. Confirm the matching phrase on this phone." }
        }
    }

    private fun discoverHost() = runOnNetwork("Listening for SuperShare on the local hotspot…") {
        var found: String? = null
        DatagramSocket(0).use { socket ->
            socket.soTimeout = 1200
            socket.broadcast = true
            val deadline = System.currentTimeMillis() + 12_000
            val buffer = ByteArray(2048)
            while (found == null && System.currentTimeMillis() < deadline) {
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val data = JSONObject(String(packet.data, packet.offset, packet.length, Charsets.UTF_8))
                    if (data.optString("service") == "SuperShare" && data.optInt("protocol_version") == 1) {
                        val candidate = "http://${packet.address.hostAddress}:${data.getInt("port")}"
                        val previousHost = baseHost
                        baseHost = candidate
                        try {
                            val handshake = JSONObject(request("/api/network", "GET", null))
                            if (handshake.optString("service") == "SuperShare" && handshake.optInt("protocol_version") == 1) found = candidate
                        } catch (_: Exception) { }
                        if (found == null) baseHost = previousHost
                    }
                } catch (_: java.net.SocketTimeoutException) { }
            }
        }
        val result = found
        runOnUiThread {
            if (result != null) { baseHost = result; hostInput.setText(result); statusText.text = "Laptop found. Enter the pairing code shown in its terminal." }
            else statusText.text = "No host announcement received. Check that both devices use the same hotspot, then enter the laptop address manually."
        }
    }

    private fun confirmPairing() = runOnNetwork("Confirming phrase…") {
        request("/api/devices/confirm-pairing", "POST", "{}")
        prefs.edit().remove("phrase").apply()
        runOnUiThread { phraseText.text = "Phrase confirmed. Wait for laptop approval."; confirmButton.isEnabled = false; statusText.text = "The laptop can now grant send access." }
    }

    private fun sendPending() {
        if (pendingUris.isEmpty()) { statusText.text = "Choose files with the device picker or share them from another app first."; return }
        runOnNetwork("Checking host access…") {
            val permissionText = request("/api/upload-permission?device=${deviceId}", "GET", null)
            val permission = JSONObject(permissionText)
            if (!permission.optBoolean("allowed")) error(permission.optString("message", "The laptop has not granted send access."))
        var cancelled = false
        var sentCount = 0
        var skippedCount = 0
        for (uri in pendingUris) {
            when (upload(uri)) { 1 -> sentCount++; 0 -> skippedCount++; else -> { cancelled = true; break } }
        }
            pendingUris = emptyList()
        runOnUiThread {
            statusText.text = if (cancelled) "Transfer cancelled after sending $sentCount file(s); skipped $skippedCount. Completed files remain on the laptop."
            else "Sent $sentCount file(s); skipped $skippedCount. Destination: the laptop's selected receive folder."
        }
        }
    }

    private fun upload(uri: Uri): Int {
        val name = displayName(uri)
        val size = contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
        if (size < 0) error("$name: this file provider does not report its size; this version cannot send it safely.")
        var collision = "ask"
        var createdText: String
        try {
            createdText = createUploadSession(name, size, collision)
        } catch (error: Exception) {
            if (!error.message.orEmpty().startsWith("409:")) throw error
            collision = askCollisionChoice(name)
            if (collision == "cancel") return -1
            if (collision == "skip") return 0
            createdText = createUploadSession(name, size, collision)
        }
        val session = JSONObject(createdText)
        val id = session.getString("id")
        val destinationName = session.optString("filename", name)
        val chunkSize = session.getInt("chunk_size")
        var offset = 0L
        contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(chunkSize)
            while (offset < size) {
                val wanted = minOf(buffer.size.toLong(), size - offset).toInt()
                var count = 0
                while (count < wanted) { val read = input.read(buffer, count, wanted - count); if (read < 0) error("$name: source ended before the declared size."); count += read }
                val chunk = buffer.copyOf(count)
                val chunkHash = MessageDigest.getInstance("SHA-256").digest(chunk).joinToString("") { "%02x".format(it) }
                request("/api/transfers/$id/chunk", "PUT", chunk, mapOf("X-Chunk-Offset" to offset.toString(), "X-Chunk-SHA256" to chunkHash))
                offset += count
                runOnUiThread { statusText.text = "Sending $name as $destinationName · $offset of $size bytes" }
            }
        } ?: error("Could not open $name from its original content URI.")
        request("/api/transfers/$id/complete", "POST", "{}")
        return 1
    }

    private fun displayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getString(0) ?: "shared-file.bin"
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "shared-file.bin"
    }

    private fun createUploadSession(name: String, size: Long, collision: String): String = request(
        "/api/transfers", "POST",
        JSONObject().put("name", name).put("size", size).put("path", name).put("collision", collision).toString()
    )

    private fun askCollisionChoice(name: String): String {
        val latch = CountDownLatch(1)
        var choice = "cancel"
        runOnUiThread {
            AlertDialog.Builder(this).setTitle("$name already exists on the laptop")
                .setMessage("Choose how to handle the existing file. Replace overwrites it only after the new transfer verifies.")
                .setItems(arrayOf("Keep both (rename incoming)", "Replace existing file", "Skip this file", "Cancel")) { _, selected ->
                    choice = when (selected) { 0 -> "rename"; 1 -> "replace"; 2 -> "skip"; else -> "cancel" }
                    latch.countDown()
                }.setOnCancelListener { latch.countDown() }.show()
        }
        if (!latch.await(5, TimeUnit.MINUTES)) return "cancel"
        return choice
    }

    private fun normalizeHost(): String = baseHost.trim().trimEnd('/')

    private fun request(path: String, method: String, body: Any?, extraHeaders: Map<String, String> = emptyMap()): String {
        val host = normalizeHost().ifBlank { error("Enter the laptop address first.") }
        val connection = (URL("$host$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 60_000
            setRequestProperty("X-SuperShare-Device", deviceId)
            setRequestProperty("X-SuperShare-Name", android.os.Build.MODEL)
            setRequestProperty("X-SuperShare-Type", "Android")
            prefs.getString("cookie", null)?.let { setRequestProperty("Cookie", it) }
            extraHeaders.forEach { (key, value) -> setRequestProperty(key, value) }
            if (body is String) setRequestProperty("Content-Type", "application/json")
            if (body != null) doOutput = true
        }
        if (body != null) connection.outputStream.use { output -> when (body) { is String -> output.write(body.toByteArray(Charsets.UTF_8)); is ByteArray -> output.write(body) } }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val response = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        responseCookie = connection.getHeaderField("Set-Cookie")?.substringBefore(';')
        connection.disconnect()
        if (code !in 200..299) error("$code:${response.ifBlank { "Request failed" }}")
        return response
    }

    private fun runOnNetwork(message: String, action: () -> Unit) {
        statusText.text = message
        pairButton.isEnabled = false
        executor.execute {
            try { action() } catch (error: Exception) { runOnUiThread { statusText.text = error.message ?: "Connection failed" } }
            finally { runOnUiThread { pairButton.isEnabled = true } }
        }
    }

    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
}
