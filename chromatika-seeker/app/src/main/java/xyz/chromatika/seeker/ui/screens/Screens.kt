package xyz.chromatika.seeker.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.navigation.NavHostController
import kotlinx.coroutines.flow.StateFlow
import xyz.chromatika.seeker.ChromatikaApp
import xyz.chromatika.seeker.ui.components.AddressRow
import xyz.chromatika.seeker.ui.nav.NavRoute
import xyz.chromatika.seeker.vault.UnlockSession

/**
 * top-level destination placeholders for phase 0 + phase 1. each becomes a real composable in
 * its corresponding phase per the plan's page-port table. the surface here is shaped enough
 * that a screenshot tells the user which screen is mounted, but no real data flows yet.
 */

@Composable
fun WalletScreen(navController: NavHostController) {
    val app = remember { ChromatikaApp.get() }
    val session: UnlockSession? by app.vaultRepository.session.collectAsState(initial = null)
    val active = session?.activeAccount

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
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("balance", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        text = "? SOL",
                        style = MaterialTheme.typography.headlineMedium,
                    )
                    Text(
                        text = "live balances wire next iteration (ktor JSON-RPC to api.devnet.solana.com).",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
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

@Suppress("unused")
private fun <T> StateFlow<T>.unused() = Unit

@Composable
fun SendScreen(navController: NavHostController) {
    PlaceholderHomeScreen(
        title = "send",
        phase = "phase 3 - chain-specific send flows route through here",
        actions = listOf(
            "networks" to NavRoute.NETWORK_SELECTOR,
            "vault management" to NavRoute.VAULT_MANAGEMENT,
        ),
        navController = navController,
    )
}

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

@Composable
fun SettingsScreen(navController: NavHostController) {
    PlaceholderHomeScreen(
        title = "settings",
        phase = "phase 1 - vault, networks, MCP agents, alerts, safety",
        actions = listOf(
            "networks" to NavRoute.NETWORK_SELECTOR,
            "vault management" to NavRoute.VAULT_MANAGEMENT,
            "agents (MCP)" to NavRoute.AGENTS,
            "policy vault" to NavRoute.POLICY_VAULT,
        ),
        navController = navController,
    )
}

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
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
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
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                text = "signatures come from a single mock signer, not distributed MPC. do not submit real-value transactions through ika-on-solana. mainnet solana sends use seed vault directly.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
        }
    }
}
