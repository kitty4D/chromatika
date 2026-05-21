package xyz.chromatika.seeker.data.settings

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import xyz.chromatika.seeker.chains.solana.SolanaCluster

/**
 * DataStore<Preferences>-backed [AppSettings] persistence. one shared store under the
 * `chromatika_settings_v1` filename (separate from the vault datastore so settings survive
 * a vault wipe). matches the chrome extension's `chromatika_*_v1` key naming convention.
 *
 * threading: every read returns a [Flow] that emits on every write. setters suspend on
 * [Dispatchers.IO] internally; callers can invoke from any context.
 */
class SettingsStore(context: Context) {

    private val ds = context.settingsDataStore

    /** the canonical [Flow] of current settings. emits the latest stored value on every write. */
    val flow: Flow<AppSettings> = ds.data.map { prefs -> prefs.toAppSettings() }

    /** convenience: just the cluster flow, useful for viewmodels that only care about cluster. */
    val clusterFlow: Flow<SolanaCluster> = flow.map { it.solanaCluster }

    suspend fun setSolanaCluster(cluster: SolanaCluster) {
        ds.edit { prefs -> prefs[KEY_CLUSTER] = cluster.name }
    }

    /** wipe every setting. used by "reset to defaults" or by test fixtures. */
    suspend fun reset() {
        ds.edit { prefs -> prefs.clear() }
    }

    companion object {
        // string keys match the chrome extension's `chromatika_*_v1` convention.
        internal val KEY_CLUSTER = stringPreferencesKey("chromatika_solana_cluster_v1")

        fun Preferences.toAppSettings(): AppSettings {
            val clusterName = this[KEY_CLUSTER]
            val cluster = runCatching { clusterName?.let { SolanaCluster.valueOf(it) } }.getOrNull()
                ?: SolanaCluster.Mainnet
            return AppSettings(solanaCluster = cluster)
        }
    }
}

private val Context.settingsDataStore by preferencesDataStore(name = "chromatika_settings")
