package xyz.chromatika.seeker.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import xyz.chromatika.seeker.chains.solana.SolanaCluster
import xyz.chromatika.seeker.ui.nav.NavRoute
import xyz.chromatika.seeker.ui.screens.PreAlphaBanner

/**
 * settings home. minimum viable: cluster selector + links into the rest of the existing
 * detail screens (vault management, networks, agents, policy vault). future sections
 * (media safety mode, theme appearance, advanced mode, biometric unlock) layer on top
 * without changing the surface shape.
 */
@Composable
fun SettingsScreen(navController: NavHostController) {
    val viewModel: SettingsViewModel = viewModel()
    val settings by viewModel.settings.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("settings", style = MaterialTheme.typography.displaySmall)

        SectionLabel("network")
        ClusterCard(
            current = settings.solanaCluster,
            onSelect = viewModel::setSolanaCluster,
        )

        SectionLabel("vault")
        OutlinedButton(
            onClick = { navController.navigate(NavRoute.VAULT_MANAGEMENT) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("vault management") }

        SectionLabel("dapp + agent surfaces")
        OutlinedButton(
            onClick = { navController.navigate(NavRoute.AGENTS) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("agents (MCP)") }

        SectionLabel("safety")
        OutlinedButton(
            onClick = { navController.navigate(NavRoute.POLICY_VAULT) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("policy vault") }

        PreAlphaBanner()
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 8.dp),
    )
}

@Composable
private fun ClusterCard(current: SolanaCluster, onSelect: (SolanaCluster) -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            ClusterRow(
                cluster = SolanaCluster.Mainnet,
                selected = current == SolanaCluster.Mainnet,
                helper = "real SOL. funded addresses move real value.",
                onClick = { onSelect(SolanaCluster.Mainnet) },
            )
            ClusterRow(
                cluster = SolanaCluster.Devnet,
                selected = current == SolanaCluster.Devnet,
                helper = "safe sandbox. fund via faucet, send freely, throwaway SOL.",
                onClick = { onSelect(SolanaCluster.Devnet) },
            )
            ClusterRow(
                cluster = SolanaCluster.Testnet,
                selected = current == SolanaCluster.Testnet,
                helper = "validator pre-release testing. usually less stable than devnet.",
                onClick = { onSelect(SolanaCluster.Testnet) },
            )
        }
    }
}

@Composable
private fun ClusterRow(
    cluster: SolanaCluster,
    selected: Boolean,
    helper: String,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Column(modifier = Modifier.fillMaxWidth()) {
            Text(cluster.explorerCluster, style = MaterialTheme.typography.titleMedium)
            Text(
                helper,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
