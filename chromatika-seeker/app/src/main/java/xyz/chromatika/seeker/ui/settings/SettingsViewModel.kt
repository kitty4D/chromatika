package xyz.chromatika.seeker.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import xyz.chromatika.seeker.ChromatikaApp
import xyz.chromatika.seeker.chains.solana.SolanaCluster
import xyz.chromatika.seeker.data.settings.AppSettings

/** owns the read + write surface for the settings screen. compose observes [settings]. */
class SettingsViewModel : ViewModel() {

    private val store = ChromatikaApp.get().settingsStore

    /** current settings as a state flow. starts emitting the persisted value once observed. */
    val settings: StateFlow<AppSettings> = store.flow.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000L),
        initialValue = AppSettings(),
    )

    fun setSolanaCluster(cluster: SolanaCluster) {
        viewModelScope.launch { store.setSolanaCluster(cluster) }
    }
}
