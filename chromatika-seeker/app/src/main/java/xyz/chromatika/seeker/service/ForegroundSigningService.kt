package xyz.chromatika.seeker.service

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * placeholder for the foreground service that will host the ika webview off the main thread.
 * lands fully in phase 2 (ika JS bridge) and phase 6 (background workers parity). today it
 * exists only so the manifest's `<service>` declaration resolves at build time.
 */
class ForegroundSigningService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
}
