package xyz.chromatika.seeker.data.settings

import androidx.datastore.preferences.core.mutablePreferencesOf
import org.junit.Assert.assertEquals
import org.junit.Test
import xyz.chromatika.seeker.chains.solana.SolanaCluster
import xyz.chromatika.seeker.data.settings.SettingsStore.Companion.KEY_CLUSTER
import xyz.chromatika.seeker.data.settings.SettingsStore.Companion.toAppSettings

/**
 * unit-level coverage for the preferences -> AppSettings mapping. the full DataStore round
 * trip is an instrumented test (needs an android Context); these run on the JVM and pin
 * the mapping contract.
 */
class AppSettingsTest {

    @Test
    fun `empty prefs default to mainnet`() {
        val prefs = mutablePreferencesOf()
        val settings = prefs.toAppSettings()
        assertEquals(SolanaCluster.Mainnet, settings.solanaCluster)
    }

    @Test
    fun `valid cluster name round-trips`() {
        for (cluster in SolanaCluster.entries) {
            val prefs = mutablePreferencesOf()
            prefs[KEY_CLUSTER] = cluster.name
            val settings = prefs.toAppSettings()
            assertEquals(cluster, settings.solanaCluster)
        }
    }

    @Test
    fun `unknown cluster name falls back to mainnet (forward-compat)`() {
        // if a future build wrote a cluster the current build doesn't recognize, fall back
        // safely instead of crashing on startup.
        val prefs = mutablePreferencesOf()
        prefs[KEY_CLUSTER] = "FutureCluster"
        val settings = prefs.toAppSettings()
        assertEquals(SolanaCluster.Mainnet, settings.solanaCluster)
    }

    @Test
    fun `default AppSettings construction has mainnet`() {
        assertEquals(SolanaCluster.Mainnet, AppSettings().solanaCluster)
    }
}
