package xyz.chromatika.seeker.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import kotlinx.coroutines.flow.StateFlow
import xyz.chromatika.seeker.ChromatikaApp
import xyz.chromatika.seeker.chains.solana.SolanaCluster
import xyz.chromatika.seeker.chains.solana.SolanaFormat
import xyz.chromatika.seeker.ui.components.AddressRow
import xyz.chromatika.seeker.ui.nav.NavRoute
import xyz.chromatika.seeker.ui.theme.ChromaBanner
import xyz.chromatika.seeker.ui.wallet.WalletUiState
import xyz.chromatika.seeker.ui.wallet.WalletViewModel
import xyz.chromatika.seeker.vault.UnlockSession

/**
 * top-level destination placeholders for phase 0 + phase 1. each becomes a real composable in
 * its corresponding phase per the plan's page-port table. the surface here is shaped enough
 * that a screenshot tells the user which screen is mounted, but no real data flows yet.
 */

@Composable
fun WalletScreen(navController: NavHostController) {
    val viewModel: WalletViewModel = viewModel()
    val state: WalletUiState by viewModel.state.collectAsState()
    val active = state.activeAccount

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("wallet", style = MaterialTheme.typography.displaySmall)
        if (active != null) {
            Text(
                text = active.label,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            AddressRow(label = "solana address", value = active.solanaAddressBase58)
            BalanceCard(state = state, onRefresh = viewModel::refresh)
            if (state.cluster != null && state.cluster != SolanaCluster.Mainnet) {
                AirdropCard(state = state, onRequest = { viewModel.requestAirdrop() }, onDismissFeedback = viewModel::clearAirdropFeedback)
            }
        } else {
            Text(
                "no active account yet. unlock the vault to surface your solana address.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        PreAlphaBanner()
        OutlinedButton(
            onClick = { navController.navigate(NavRoute.VAULT_MANAGEMENT) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("vault management") }
        OutlinedButton(
            onClick = { navController.navigate(NavRoute.IKA_STAKING) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("ika staking") }
        OutlinedButton(
            onClick = { navController.navigate(NavRoute.POLICY_VAULT) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("policy vault") }
    }
}

@Composable
private fun AirdropCard(
    state: WalletUiState,
    onRequest: () -> Unit,
    onDismissFeedback: () -> Unit,
) {
    val cluster = state.cluster ?: return
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = "${cluster.explorerCluster} faucet",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = "request 1 SOL from the public ${cluster.explorerCluster} faucet to fund this address for testing. mainnet has no faucet.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (state.airdropInFlight) {
                androidx.compose.foundation.layout.Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(
                        text = state.airdropMessage ?: "requesting airdrop…",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                Button(
                    onClick = onRequest,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("request 1 SOL airdrop") }
            }
            state.airdropError?.let { err ->
                Card(
                    colors = CardDefaults.cardColors(containerColor = ChromaBanner.errorBg),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("airdrop failed", style = MaterialTheme.typography.titleSmall, color = ChromaBanner.errorFg)
                        Text(err, style = MaterialTheme.typography.bodySmall, color = ChromaBanner.errorFg)
                        TextButton(onClick = onDismissFeedback) { Text("dismiss", color = ChromaBanner.errorFg) }
                    }
                }
            }
            if (state.airdropError == null && state.airdropMessage != null && !state.airdropInFlight) {
                Text(
                    text = state.airdropMessage,
                    style = MaterialTheme.typography.bodySmall,
                    color = ChromaBanner.successFg,
                )
            }
        }
    }
}

@Composable
private fun BalanceCard(state: WalletUiState, onRefresh: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column {
                    Text(
                        text = "balance",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    state.cluster?.let { cluster ->
                        Text(
                            text = cluster.explorerCluster,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                IconButton(onClick = onRefresh, enabled = !state.isLoading) {
                    if (state.isLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Outlined.Refresh,
                            contentDescription = "refresh balance",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    text = state.lamports?.let { SolanaFormat.formatSol(it) } ?: "—",
                    style = MaterialTheme.typography.displayMedium,
                )
                Box(modifier = Modifier.size(8.dp))
                Text(
                    text = "SOL",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            }
            val updatedAt = state.lastUpdatedEpochMs
            if (state.errorMessage != null) {
                Text(
                    text = "couldn't fetch balance: ${state.errorMessage}",
                    style = MaterialTheme.typography.bodySmall,
                    color = ChromaBanner.errorFg,
                )
            } else if (updatedAt != null) {
                val ago = formatTimeAgo(System.currentTimeMillis() - updatedAt)
                Text(
                    text = "updated $ago",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else if (state.isLoading) {
                Text(
                    text = "fetching from ${state.cluster?.rpcUrl ?: "rpc"}…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun formatTimeAgo(diffMs: Long): String {
    val sec = (diffMs / 1000L).coerceAtLeast(0)
    return when {
        sec < 5 -> "just now"
        sec < 60 -> "${sec}s ago"
        sec < 3600 -> "${sec / 60}m ago"
        else -> "${sec / 3600}h ago"
    }
}

@Suppress("unused")
private fun <T> StateFlow<T>.unused() = Unit

@Suppress("unused")
private fun unusedVault(s: UnlockSession?, app: ChromatikaApp) = Unit

// SendScreen lives in [xyz.chromatika.seeker.ui.send.SendScreen]. the nav graph wires it in.

@Composable
fun ActivityScreen(navController: NavHostController) {
    PlaceholderHomeScreen(
        title = "activity",
        phase = "phase 4 - cross-chain history + signed-tx merge",
        actions = listOf(
            "payments (x402)" to NavRoute.PAYMENTS,
        ),
        navController = navController,
    )
}

@Composable
fun NftsScreen(navController: NavHostController) {
    PlaceholderHomeScreen(
        title = "nfts",
        phase = "phase 4 - on-chain NFTs + kiosk panel",
        actions = emptyList(),
        navController = navController,
    )
}

// SettingsScreen lives in [xyz.chromatika.seeker.ui.settings.SettingsScreen]. nav wires it.

@Composable
private fun PlaceholderHomeScreen(
    title: String,
    phase: String,
    actions: List<Pair<String, String>>,
    navController: NavHostController,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = MaterialTheme.typography.displaySmall)
        Text(phase, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PreAlphaBanner()
        actions.forEach { (label, route) ->
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                modifier = Modifier.fillMaxWidth(),
            ) {
                TextButton(onClick = { navController.navigate(route) }) {
                    Text(label, style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
}

@Composable
fun PlaceholderDetailScreen(
    title: String,
    phase: String,
    description: String,
    onBack: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TextButton(onClick = onBack) { Text("back") }
        Text(title, style = MaterialTheme.typography.headlineMedium)
        Text(phase, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary)
        Text(description, style = MaterialTheme.typography.bodyLarge)
        PreAlphaBanner()
    }
}

@Composable
fun PreAlphaBanner() {
    // canonical "warn" severity tint per `theme.css` --theme-banner-warn-{bg,fg}.
    // the pre-alpha disclaimer is severe but not error-state (everything still works on
    // devnet); warn matches the extension's treatment.
    Card(
        colors = CardDefaults.cardColors(containerColor = ChromaBanner.warnBg),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = "solana ika base is devnet-only pre-alpha.",
                style = MaterialTheme.typography.titleSmall,
                color = ChromaBanner.warnFg,
            )
            Text(
                text = "signatures come from a single mock signer, not distributed MPC. do not submit real-value transactions through ika-on-solana. mainnet solana sends use seed vault directly.",
                style = MaterialTheme.typography.bodySmall,
                color = ChromaBanner.warnFg,
            )
        }
    }
}
