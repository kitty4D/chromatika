package xyz.chromatika.seeker.ui.wallet

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import xyz.chromatika.seeker.ChromatikaApp
import xyz.chromatika.seeker.chains.solana.SolanaCluster
import xyz.chromatika.seeker.chains.solana.SolanaRpc
import xyz.chromatika.seeker.vault.AccountRecord
import xyz.chromatika.seeker.vault.UnlockSession

/**
 * drives the wallet home. observes the active vault session **and** the active solana cluster
 * (from [xyz.chromatika.seeker.data.settings.SettingsStore]); when either changes we cancel
 * the in-flight poll, swap the [SolanaRpc] client, and restart polling against the new
 * endpoint.
 *
 * also drives the devnet/testnet airdrop button. mainnet has no faucet so the button hides
 * itself on mainnet.
 */
class WalletViewModel : ViewModel() {

    private val app: ChromatikaApp get() = ChromatikaApp.get()

    private var rpc: SolanaRpc? = null

    private val _state = MutableStateFlow(WalletUiState())
    val state: StateFlow<WalletUiState> = _state.asStateFlow()

    private var pollJob: Job? = null
    private var airdropJob: Job? = null

    init {
        viewModelScope.launch {
            app.settingsStore.clusterFlow.collectLatest { cluster ->
                onClusterChanged(cluster)
            }
        }
        viewModelScope.launch {
            app.vaultRepository.session.collectLatest { session ->
                onSessionChanged(session)
            }
        }
    }

    /** user tapped the refresh icon. fetches once immediately, doesn't change the cadence. */
    fun refresh() {
        val account = _state.value.activeAccount ?: return
        viewModelScope.launch { fetchOnce(account) }
    }

    /**
     * request 1 SOL from the devnet/testnet faucet. mainnet has no faucet so the button
     * shouldn't even render there; we double-check anyway. submits an airdrop request,
     * polls for confirmation, refreshes the balance.
     */
    fun requestAirdrop(lamports: Long = 1_000_000_000L) {
        val account = _state.value.activeAccount ?: return
        val cluster = _state.value.cluster ?: return
        val client = rpc ?: return
        if (cluster == SolanaCluster.Mainnet) {
            _state.value = _state.value.copy(
                airdropError = "airdrop is only available on devnet + testnet. switch in settings.",
            )
            return
        }
        if (airdropJob?.isActive == true) return
        _state.value = _state.value.copy(
            airdropInFlight = true,
            airdropError = null,
            airdropSignature = null,
            airdropMessage = "requesting $lamports lamports from the ${cluster.explorerCluster} faucet…",
        )
        airdropJob = viewModelScope.launch {
            try {
                val sig = client.requestAirdrop(account.solanaAddressBase58, lamports)
                _state.value = _state.value.copy(
                    airdropSignature = sig,
                    airdropMessage = "airdrop signature received. waiting for confirmation…",
                )
                pollAirdrop(client, sig)
            } catch (e: Throwable) {
                _state.value = _state.value.copy(
                    airdropInFlight = false,
                    airdropError = e.message ?: e.javaClass.simpleName,
                    airdropMessage = null,
                )
            }
        }
    }

    /** dismiss whatever the airdrop card is currently showing (success message, error, etc). */
    fun clearAirdropFeedback() {
        _state.value = _state.value.copy(
            airdropError = null,
            airdropMessage = null,
            airdropSignature = null,
        )
    }

    /* ----------------------------------------------------------------------------
     * internals
     * ---------------------------------------------------------------------------- */

    private suspend fun onClusterChanged(cluster: SolanaCluster) {
        pollJob?.cancel()
        airdropJob?.cancel()
        rpc?.close()
        rpc = SolanaRpc(cluster)
        val active = _state.value.activeAccount
        _state.value = _state.value.copy(
            cluster = cluster,
            lamports = null,
            errorMessage = null,
            isLoading = active != null,
            lastUpdatedEpochMs = null,
            airdropInFlight = false,
            airdropError = null,
            airdropMessage = null,
            airdropSignature = null,
        )
        if (active != null) startPolling(active)
    }

    private suspend fun onSessionChanged(session: UnlockSession?) {
        pollJob?.cancel()
        val active = session?.activeAccount
        _state.value = _state.value.copy(
            activeAccount = active,
            lamports = if (active?.id == _state.value.activeAccount?.id) _state.value.lamports else null,
            errorMessage = null,
            isLoading = active != null && rpc != null,
        )
        if (active != null && rpc != null) startPolling(active)
    }

    private fun startPolling(account: AccountRecord) {
        pollJob = viewModelScope.launch {
            while (true) {
                fetchOnce(account)
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    private suspend fun fetchOnce(account: AccountRecord) {
        val client = rpc ?: return
        _state.value = _state.value.copy(isLoading = true)
        try {
            val lamports = client.getBalance(account.solanaAddressBase58)
            _state.value = _state.value.copy(
                lamports = lamports,
                isLoading = false,
                lastUpdatedEpochMs = System.currentTimeMillis(),
                errorMessage = null,
            )
        } catch (e: Throwable) {
            _state.value = _state.value.copy(
                isLoading = false,
                errorMessage = e.message ?: e.javaClass.simpleName,
            )
        }
    }

    /** poll the airdrop signature for confirmation, then refresh the balance. */
    private suspend fun pollAirdrop(client: SolanaRpc, signature: String) {
        val deadline = System.currentTimeMillis() + AIRDROP_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            try {
                val statuses = client.getSignatureStatuses(listOf(signature))
                val s = statuses.firstOrNull()
                if (s != null) {
                    if (s.err != null) {
                        _state.value = _state.value.copy(
                            airdropInFlight = false,
                            airdropError = "airdrop landed but errored: ${s.err}",
                            airdropMessage = null,
                        )
                        return
                    }
                    if (s.confirmationStatus == "confirmed" || s.confirmationStatus == "finalized") {
                        _state.value = _state.value.copy(
                            airdropInFlight = false,
                            airdropMessage = "airdrop confirmed. balance updating…",
                        )
                        _state.value.activeAccount?.let { fetchOnce(it) }
                        return
                    }
                }
            } catch (_: Throwable) {
                // keep polling
            }
            delay(AIRDROP_POLL_INTERVAL_MS)
        }
        _state.value = _state.value.copy(
            airdropInFlight = false,
            airdropError = "airdrop timed out. it might still confirm later; check the explorer.",
            airdropMessage = null,
        )
    }

    override fun onCleared() {
        pollJob?.cancel()
        airdropJob?.cancel()
        rpc?.close()
        super.onCleared()
    }

    companion object {
        private const val POLL_INTERVAL_MS: Long = 10_000L
        private const val AIRDROP_TIMEOUT_MS: Long = 60_000L
        private const val AIRDROP_POLL_INTERVAL_MS: Long = 1_500L
    }
}

/**
 * single source of truth for the wallet home. survives the live polling loop so transient
 * errors don't blank the previously-shown balance.
 */
data class WalletUiState(
    val activeAccount: AccountRecord? = null,
    val cluster: SolanaCluster? = null,
    /** last successfully-fetched balance, null until the first fetch resolves. */
    val lamports: Long? = null,
    val isLoading: Boolean = false,
    val lastUpdatedEpochMs: Long? = null,
    val errorMessage: String? = null,
    /* ---- airdrop state ---- */
    val airdropInFlight: Boolean = false,
    val airdropMessage: String? = null,
    val airdropError: String? = null,
    val airdropSignature: String? = null,
)
