package xyz.chromatika.seeker.ui.send

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import xyz.chromatika.seeker.ChromatikaApp
import xyz.chromatika.seeker.chains.solana.Base58
import xyz.chromatika.seeker.chains.solana.SOLANA_BASE_FEE_LAMPORTS_PER_SIG
import xyz.chromatika.seeker.chains.solana.SendValidationException
import xyz.chromatika.seeker.chains.solana.SolanaCluster
import xyz.chromatika.seeker.chains.solana.SolanaFormat
import xyz.chromatika.seeker.chains.solana.SolanaRpc
import xyz.chromatika.seeker.chains.solana.SolanaSendNative
import xyz.chromatika.seeker.vault.AccountRecord
import xyz.chromatika.seeker.vault.UnlockSession

/**
 * drives the send flow. wraps [SolanaSendNative] with a state machine the compose surface
 * observes:
 *
 *  - [SendStep.Editing] form is up, user filling in recipient + amount.
 *  - [SendStep.Reviewing] confirm pane is up.
 *  - [SendStep.Broadcasting] network in flight.
 *  - [SendStep.Sent] tx broadcast. signature + explorer link shown.
 *  - [SendStep.Failed] user-actionable error.
 *
 * also observes the **active cluster** from settings - swap to devnet from the settings
 * screen and the next send goes to devnet without a viewmodel restart.
 */
class SendViewModel : ViewModel() {

    private val app: ChromatikaApp get() = ChromatikaApp.get()

    private var rpc: SolanaRpc? = null
    private var sender: SolanaSendNative? = null

    private val _state = MutableStateFlow(SendUiState(cluster = SolanaCluster.Mainnet))
    val state: StateFlow<SendUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            app.settingsStore.clusterFlow.collectLatest { cluster -> onClusterChanged(cluster) }
        }
        viewModelScope.launch {
            app.vaultRepository.session.collectLatest { session ->
                _state.value = _state.value.copy(
                    fromAccount = session?.activeAccount,
                    sessionAvailable = session != null,
                )
                refreshBalance()
            }
        }
    }

    fun setRecipient(input: String) {
        _state.value = _state.value.copy(recipientInput = input, recipientError = null, broadcastError = null)
    }

    fun setAmountSol(input: String) {
        _state.value = _state.value.copy(amountInput = input, amountError = null, broadcastError = null)
    }

    fun review() {
        val s = _state.value
        val recipientError = validateRecipient(s.recipientInput)
        val (lamports, amountError) = validateAmountAndParse(s.amountInput, s.balanceLamports)
        if (recipientError != null || amountError != null) {
            _state.value = s.copy(recipientError = recipientError, amountError = amountError)
            return
        }
        _state.value = s.copy(
            recipientError = null,
            amountError = null,
            broadcastError = null,
            previewLamports = lamports,
            step = SendStep.Reviewing,
        )
    }

    fun backToEditing() {
        _state.value = _state.value.copy(step = SendStep.Editing)
    }

    fun confirmAndBroadcast() {
        val s = _state.value
        val account = s.fromAccount ?: return
        val lamports = s.previewLamports ?: return
        val session = app.vaultRepository.session.value ?: return
        val sendNative = sender ?: return
        _state.value = s.copy(step = SendStep.Broadcasting, broadcastError = null)
        viewModelScope.launch {
            try {
                val identity = session.identityFor(account.id)
                val result = sendNative.send(
                    identity = identity,
                    recipientBase58 = s.recipientInput.trim(),
                    lamports = lamports,
                )
                _state.value = _state.value.copy(
                    step = SendStep.Sent(
                        signatureBase58 = result.signatureBase58,
                        explorerUrl = result.explorerUrl,
                        amountLamports = lamports,
                        recipientBase58 = s.recipientInput.trim(),
                        confirmation = ConfirmationStatus.Pending,
                    ),
                )
                // poll for confirmation in the background; the UI stays on the Sent pane
                // and the pill animates as the status progresses.
                viewModelScope.launch { pollConfirmation(result.signatureBase58) }
                refreshBalance()
            } catch (e: SendValidationException) {
                _state.value = _state.value.copy(
                    step = SendStep.Editing,
                    recipientError = e.message ?: "invalid recipient",
                )
            } catch (e: Throwable) {
                _state.value = _state.value.copy(
                    step = SendStep.Failed(e.message ?: e.javaClass.simpleName),
                )
            }
        }
    }

    /**
     * background poll of `getSignatureStatuses` after a successful broadcast. updates the
     * `Sent.confirmation` pill as the validator state machine progresses. gives up after
     * [CONFIRM_TIMEOUT_MS] with the `TimedOut` status; the tx might still land later but
     * the user can hit "open on solana explorer" to check.
     */
    private suspend fun pollConfirmation(signatureBase58: String) {
        val client = rpc ?: return
        val deadline = System.currentTimeMillis() + CONFIRM_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val status: ConfirmationStatus = try {
                val statuses = client.getSignatureStatuses(listOf(signatureBase58))
                val s = statuses.firstOrNull()
                when {
                    s == null -> ConfirmationStatus.Pending
                    s.err != null -> ConfirmationStatus.Errored
                    s.confirmationStatus == "finalized" -> ConfirmationStatus.Finalized
                    s.confirmationStatus == "confirmed" -> ConfirmationStatus.Confirmed
                    s.confirmationStatus == "processed" -> ConfirmationStatus.Processed
                    else -> ConfirmationStatus.Pending
                }
            } catch (_: Throwable) {
                // transient rpc flake: keep trying until the deadline.
                ConfirmationStatus.Pending
            }
            updateSentConfirmation(status, signatureBase58)
            if (status == ConfirmationStatus.Finalized || status == ConfirmationStatus.Errored) return
            delay(CONFIRM_POLL_INTERVAL_MS)
        }
        // deadline reached without a terminal status
        updateSentConfirmation(ConfirmationStatus.TimedOut, signatureBase58)
    }

    /** thread-safe update of the Sent confirmation pill; preserves the rest of the Sent state. */
    private fun updateSentConfirmation(status: ConfirmationStatus, signatureBase58: String) {
        val current = _state.value.step as? SendStep.Sent ?: return
        // ignore late updates if the user has navigated away from the Sent pane
        if (current.signatureBase58 != signatureBase58) return
        if (current.confirmation == status) return
        _state.value = _state.value.copy(step = current.copy(confirmation = status))
    }

    fun resetToForm() {
        _state.value = _state.value.copy(
            step = SendStep.Editing,
            recipientInput = "",
            amountInput = "",
            previewLamports = null,
            broadcastError = null,
            recipientError = null,
            amountError = null,
        )
        viewModelScope.launch { refreshBalance() }
    }

    private suspend fun onClusterChanged(cluster: SolanaCluster) {
        rpc?.close()
        rpc = SolanaRpc(cluster)
        sender = SolanaSendNative(rpc!!)
        _state.value = _state.value.copy(cluster = cluster, balanceLamports = null)
        refreshBalance()
    }

    private suspend fun refreshBalance() {
        val account = _state.value.fromAccount ?: return
        val client = rpc ?: return
        try {
            val lamports = client.getBalance(account.solanaAddressBase58)
            _state.value = _state.value.copy(balanceLamports = lamports)
        } catch (_: Throwable) {
            // balance fetch is best-effort; we don't surface this as a hard error.
        }
    }

    override fun onCleared() {
        rpc?.close()
        super.onCleared()
    }

    companion object {
        private const val CONFIRM_TIMEOUT_MS: Long = 90_000L
        private const val CONFIRM_POLL_INTERVAL_MS: Long = 1_500L
    }

    /* ----------------------------------------------------------------------------
     * validation helpers
     * ---------------------------------------------------------------------------- */

    private fun validateRecipient(input: String): String? {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return "recipient address is required"
        return try {
            val decoded = Base58.decode(trimmed)
            if (decoded.size != 32) "address must decode to 32 bytes (got ${decoded.size})" else null
        } catch (e: Throwable) {
            "invalid base58: ${e.message ?: "parse failed"}"
        }
    }

    private fun validateAmountAndParse(input: String, balance: Long?): Pair<Long?, String?> {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return null to "amount is required"
        val lamports = try {
            SolanaFormat.lamportsFromSol(trimmed)
        } catch (e: Throwable) {
            return null to "invalid SOL amount: ${e.message ?: "parse failed"}"
        }
        if (lamports <= 0) return null to "amount must be greater than zero"
        if (balance != null && lamports + SOLANA_BASE_FEE_LAMPORTS_PER_SIG > balance) {
            return null to "not enough SOL (need ${SolanaFormat.formatSol(lamports + SOLANA_BASE_FEE_LAMPORTS_PER_SIG)} including fees, you have ${SolanaFormat.formatSol(balance)})"
        }
        return lamports to null
    }
}

/** the whole send flow's state. compose reads + the viewmodel writes. */
data class SendUiState(
    val cluster: SolanaCluster,
    val fromAccount: AccountRecord? = null,
    val sessionAvailable: Boolean = false,
    val balanceLamports: Long? = null,
    val recipientInput: String = "",
    val amountInput: String = "",
    val recipientError: String? = null,
    val amountError: String? = null,
    val previewLamports: Long? = null,
    val broadcastError: String? = null,
    val step: SendStep = SendStep.Editing,
)

/** discrete flow state. each value is exhaustive for the screen pane shown. */
sealed interface SendStep {
    data object Editing : SendStep
    data object Reviewing : SendStep
    data object Broadcasting : SendStep
    data class Sent(
        val signatureBase58: String,
        val explorerUrl: String,
        val amountLamports: Long,
        val recipientBase58: String,
        val confirmation: ConfirmationStatus = ConfirmationStatus.Pending,
    ) : SendStep
    data class Failed(val message: String) : SendStep
}

/**
 * end-to-end status of a broadcast transaction. drives the pill on the Sent pane.
 *
 *  - [Pending]: tx accepted by the rpc endpoint, but validators haven't reported it yet.
 *  - [Processed]: at least one validator confirmed; can still be reorged.
 *  - [Confirmed]: supermajority confirmed; usually finalized within a few slots.
 *  - [Finalized]: permanent on chain.
 *  - [Errored]: tx landed but its program returned an error. won't ever finalize cleanly.
 *  - [TimedOut]: poll deadline expired. tx might still land later; explorer is authoritative.
 */
enum class ConfirmationStatus {
    Pending,
    Processed,
    Confirmed,
    Finalized,
    Errored,
    TimedOut,
}
