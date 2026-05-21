package xyz.chromatika.seeker

import android.app.Application
import xyz.chromatika.seeker.data.settings.SettingsStore
import xyz.chromatika.seeker.vault.VaultRepository

class ChromatikaApp : Application() {

    /** app-scope vault repo. activities/composables read via [ChromatikaApp.get]. */
    lateinit var vaultRepository: VaultRepository
        private set

    /** app-scope settings store. cluster, theme prefs, media safety mode, etc. */
    lateinit var settingsStore: SettingsStore
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        vaultRepository = VaultRepository(this)
        settingsStore = SettingsStore(this)
        // background workers (presign refill, phishing list, alerts) wire in phase 6.
    }

    companion object {
        private var instance: ChromatikaApp? = null
        fun get(): ChromatikaApp = instance ?: error("ChromatikaApp not yet initialized")
    }
}
