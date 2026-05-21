package xyz.chromatika.seeker.ui.send

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import xyz.chromatika.seeker.chains.solana.SOLANA_BASE_FEE_LAMPORTS_PER_SIG
import xyz.chromatika.seeker.chains.solana.SolanaCluster
import xyz.chromatika.seeker.chains.solana.SolanaFormat
import xyz.chromatika.seeker.ui.components.AddressRow
import xyz.chromatika.seeker.ui.screens.PreAlphaBanner
import xyz.chromatika.seeker.ui.theme.ChromaBanner

/**
 * the send flow's single composable host. switches between form / confirm / broadcasting /
 * sent / failed panes off the viewmodel state. one composable, five sub-panes; lighter than
 * threading the entire flow through nav-compose with a route per step.
 */
@Composable
fun SendScreen(@Suppress("UNUSED_PARAMETER") navController: NavHostController) {
    val viewModel: SendViewModel = viewModel()
    val state: SendUiState by viewModel.state.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("send", style = MaterialTheme.typography.displaySmall)
        when (val step = state.step) {
            SendStep.Editing -> FormPane(state, viewModel)
            SendStep.Reviewing -> ConfirmPane(state, viewModel)
            SendStep.Broadcasting -> BroadcastingPane(state)
            is SendStep.Sent -> SentPane(step, state.cluster, viewModel)
            is SendStep.Failed -> FailedPane(step, viewModel)
        }
    }
}

/* ----------------------------------------------------------------------------
 * form pane: recipient + amount
 * ---------------------------------------------------------------------------- */

@Composable
private fun FormPane(state: SendUiState, vm: SendViewModel) {
    if (state.fromAccount == null) {
        Text(
            "no active account. unlock your vault first.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        PreAlphaBanner()
        return
    }
    Text(
        text = "from ${state.fromAccount.label} (${state.cluster.explorerCluster})",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    state.balanceLamports?.let { balance ->
        Text(
            text = "balance: ${SolanaFormat.formatSol(balance)} SOL",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    OutlinedTextField(
        value = state.recipientInput,
        onValueChange = vm::setRecipient,
        label = { Text("recipient address (base58)") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        isError = state.recipientError != null,
        supportingText = state.recipientError?.let { { Text(it) } },
    )
    OutlinedTextField(
        value = state.amountInput,
        onValueChange = vm::setAmountSol,
        label = { Text("amount (SOL)") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        isError = state.amountError != null,
        supportingText = state.amountError?.let { { Text(it) } },
    )
    Button(
        onClick = vm::review,
        enabled = state.recipientInput.isNotBlank() && state.amountInput.isNotBlank(),
        modifier = Modifier.fillMaxWidth(),
    ) { Text("review") }
    PreAlphaBanner()
}

/* ----------------------------------------------------------------------------
 * confirm pane: full props + danger banner if mainnet
 * ---------------------------------------------------------------------------- */

@Composable
private fun ConfirmPane(state: SendUiState, vm: SendViewModel) {
    val account = state.fromAccount ?: return
    val lamports = state.previewLamports ?: return
    Text(
        "review and confirm",
        style = MaterialTheme.typography.headlineSmall,
    )
    if (state.cluster == SolanaCluster.Mainnet) {
        DangerBanner(
            title = "this is mainnet. real SOL.",
            body = "broadcasting this tx moves real value. verify the recipient + amount before tapping confirm.",
        )
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PropertyRow(label = "from", value = "${account.label} (${account.solanaAddressBase58.take(6)}…${account.solanaAddressBase58.takeLast(6)})")
            PropertyRow(label = "to", value = "${state.recipientInput.take(6)}…${state.recipientInput.takeLast(6)}")
            PropertyRow(label = "amount", value = "${SolanaFormat.formatSol(lamports)} SOL")
            PropertyRow(label = "network fee", value = "${SolanaFormat.formatSol(SOLANA_BASE_FEE_LAMPORTS_PER_SIG)} SOL (estimated)")
            PropertyRow(label = "total cost", value = "${SolanaFormat.formatSol(lamports + SOLANA_BASE_FEE_LAMPORTS_PER_SIG)} SOL")
            PropertyRow(label = "network", value = state.cluster.explorerCluster)
        }
    }
    Button(
        onClick = vm::confirmAndBroadcast,
        modifier = Modifier.fillMaxWidth(),
    ) { Text("confirm and broadcast") }
    OutlinedButton(
        onClick = vm::backToEditing,
        modifier = Modifier.fillMaxWidth(),
    ) { Text("back to edit") }
    PreAlphaBanner()
}

@Composable
private fun PropertyRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun DangerBanner(title: String, body: String) {
    Card(
        colors = CardDefaults.cardColors(containerColor = ChromaBanner.errorBg),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = ChromaBanner.errorFg)
            Text(body, style = MaterialTheme.typography.bodySmall, color = ChromaBanner.errorFg)
        }
    }
}

/* ----------------------------------------------------------------------------
 * broadcasting / sent / failed panes
 * ---------------------------------------------------------------------------- */

@Composable
private fun BroadcastingPane(@Suppress("UNUSED_PARAMETER") state: SendUiState) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(modifier = Modifier.height(16.dp))
        Text("signing locally and broadcasting…", style = MaterialTheme.typography.bodyLarge)
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            "this can take up to ~30 seconds on a slow rpc.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SentPane(step: SendStep.Sent, cluster: SolanaCluster, vm: SendViewModel) {
    val ctx = LocalContext.current
    Text("sent!", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
    Text(
        text = "broadcast ${SolanaFormat.formatSol(step.amountLamports)} SOL on ${cluster.explorerCluster}.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    ConfirmationPill(status = step.confirmation)
    AddressRow(label = "signature", value = step.signatureBase58)
    AddressRow(label = "recipient", value = step.recipientBase58)
    OutlinedButton(
        onClick = {
            val intent = Intent(Intent.ACTION_VIEW, step.explorerUrl.toUri())
            ctx.startActivity(intent)
        },
        modifier = Modifier.fillMaxWidth(),
    ) { Text("open on solana explorer") }
    Button(onClick = vm::resetToForm, modifier = Modifier.fillMaxWidth()) { Text("send another") }
    PreAlphaBanner()
}

/** color-coded chip showing the confirmation state. cycles as the validator state machine
 *  progresses; gives up at the SendViewModel timeout with [ConfirmationStatus.TimedOut]. */
@Composable
private fun ConfirmationPill(status: ConfirmationStatus) {
    val (bg, fg, label) = when (status) {
        ConfirmationStatus.Pending -> Triple(ChromaBanner.runningBg, ChromaBanner.runningFg, "pending - waiting for validators")
        ConfirmationStatus.Processed -> Triple(ChromaBanner.infoBg, ChromaBanner.infoFg, "processed - in a block, can still re-org")
        ConfirmationStatus.Confirmed -> Triple(ChromaBanner.successBg, ChromaBanner.successFg, "confirmed - supermajority")
        ConfirmationStatus.Finalized -> Triple(ChromaBanner.successBg, ChromaBanner.successFg, "finalized - permanent")
        ConfirmationStatus.TimedOut -> Triple(ChromaBanner.warnBg, ChromaBanner.warnFg, "timed out - check explorer")
        ConfirmationStatus.Errored -> Triple(ChromaBanner.errorBg, ChromaBanner.errorFg, "errored on chain")
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = bg),
        modifier = Modifier.fillMaxWidth(),
    ) {
        androidx.compose.foundation.layout.Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (status == ConfirmationStatus.Pending || status == ConfirmationStatus.Processed) {
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = fg,
                )
            }
            Text(label, style = MaterialTheme.typography.bodySmall, color = fg)
        }
    }
}

@Composable
private fun FailedPane(step: SendStep.Failed, vm: SendViewModel) {
    DangerBanner(title = "couldn't broadcast", body = step.message)
    Button(onClick = vm::backToEditing, modifier = Modifier.fillMaxWidth()) { Text("back to edit") }
    TextButton(onClick = vm::resetToForm, modifier = Modifier.fillMaxWidth()) { Text("start over") }
    PreAlphaBanner()
}
