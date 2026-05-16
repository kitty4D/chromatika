package xyz.chromatika.seeker.ui.nav

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import xyz.chromatika.seeker.ChromatikaApp
import xyz.chromatika.seeker.ui.screens.ActivityScreen
import xyz.chromatika.seeker.ui.screens.NftsScreen
import xyz.chromatika.seeker.ui.screens.PlaceholderDetailScreen
import xyz.chromatika.seeker.ui.screens.SendScreen
import xyz.chromatika.seeker.ui.screens.SettingsScreen
import xyz.chromatika.seeker.ui.screens.WalletScreen
import xyz.chromatika.seeker.ui.setup.VaultSetupScreen
import xyz.chromatika.seeker.ui.unlock.UnlockScreen

/**
 * top-level nav. branches on vault state:
 *  - no vault stored → setup wizard ([NavRoute.SETUP]).
 *  - vault stored but locked → unlock screen ([NavRoute.UNLOCK]).
 *  - unlocked → main shell with bottom nav.
 *
 * the branching runs once on cold launch + reactively when state flows change. activities can
 * deep-link past it for special flows (dapp connect, x402 approval) once those land.
 */
@Composable
fun SeekerNavHost() {
    val navController = rememberNavController()
    val app = remember { ChromatikaApp.get() }
    val hasVault by app.vaultRepository.hasVaultFlow.collectAsState(initial = null)
    val session by app.vaultRepository.session.collectAsState(initial = null)

    // route based on persisted + in-memory state. only runs when those values change so the
    // user can still navigate within a branch (setup wizard sub-states, unlock retries, etc).
    LaunchedEffect(hasVault, session) {
        val target = when {
            hasVault == null -> null
            hasVault == false -> NavRoute.SETUP
            session == null -> NavRoute.UNLOCK
            else -> NavRoute.WALLET
        }
        if (target != null && navController.currentDestination?.route != target) {
            navController.navigate(target) {
                popUpTo(0) { inclusive = true }
                launchSingleTop = true
            }
        }
    }

    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route
    val showBottomBar = NavDestination.all.any { it.route == currentRoute }

    Scaffold(
        bottomBar = {
            if (showBottomBar) BottomBar(navController, backStack?.destination?.route)
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = NavRoute.SETUP,
            modifier = Modifier.padding(padding),
        ) {
            composable(NavRoute.SETUP) {
                VaultSetupScreen(onCompleted = {
                    navController.navigate(NavRoute.WALLET) {
                        popUpTo(0) { inclusive = true }
                    }
                })
            }
            composable(NavRoute.UNLOCK) {
                UnlockScreen(onUnlocked = {
                    navController.navigate(NavRoute.WALLET) {
                        popUpTo(0) { inclusive = true }
                    }
                })
            }

            composable(NavRoute.WALLET) { WalletScreen(navController) }
            composable(NavRoute.SEND) { SendScreen(navController) }
            composable(NavRoute.ACTIVITY) { ActivityScreen(navController) }
            composable(NavRoute.NFTS) { NftsScreen(navController) }
            composable(NavRoute.SETTINGS) { SettingsScreen(navController) }

            composable(NavRoute.PORTFOLIO) {
                PlaceholderDetailScreen(
                    title = "portfolio",
                    phase = "phase 4",
                    description = "consolidated USD value across every dwallet on the active vault.",
                    onBack = { navController.popBackStack() },
                )
            }
            composable(NavRoute.VAULT_MANAGEMENT) {
                PlaceholderDetailScreen(
                    title = "vault management",
                    phase = "phase 1",
                    description = "rename / remove vault, manage envelopes (password / seeker / passkey).",
                    onBack = { navController.popBackStack() },
                )
            }
            composable(NavRoute.NETWORK_SELECTOR) {
                PlaceholderDetailScreen(
                    title = "networks",
                    phase = "phase 3",
                    description = "built-in + custom networks per chain type.",
                    onBack = { navController.popBackStack() },
                )
            }
            composable(NavRoute.IKA_STAKING) {
                PlaceholderDetailScreen(
                    title = "ika staking",
                    phase = "phase 4",
                    description = "validator list + stake / withdraw via the ika JS bridge.",
                    onBack = { navController.popBackStack() },
                )
            }
            composable(NavRoute.POLICY_VAULT) {
                PlaceholderDetailScreen(
                    title = "policy vault",
                    phase = "phase 4",
                    description = "sui-only spend caps + panic + rescue.",
                    onBack = { navController.popBackStack() },
                )
            }
            composable(NavRoute.PAYMENTS) {
                PlaceholderDetailScreen(
                    title = "payments",
                    phase = "phase 7",
                    description = "x402 USDC receipt history + cap matrix.",
                    onBack = { navController.popBackStack() },
                )
            }
            composable(NavRoute.AGENTS) {
                PlaceholderDetailScreen(
                    title = "agents",
                    phase = "phase 7",
                    description = "MCP localhost server config + bearer token rotation.",
                    onBack = { navController.popBackStack() },
                )
            }
        }
    }
}

@Composable
private fun BottomBar(navController: NavHostController, currentRoute: String?) {
    NavigationBar {
        NavDestination.all.forEach { dest ->
            val selected = navController.currentBackStackEntry?.destination?.hierarchy?.any { it.route == dest.route } == true
            NavigationBarItem(
                selected = selected,
                icon = { Icon(dest.icon, contentDescription = dest.label) },
                label = { Text(dest.label) },
                onClick = {
                    if (currentRoute != dest.route) {
                        navController.navigate(dest.route) {
                            popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                            launchSingleTop = true
                            restoreState = true
                        }
                    }
                },
            )
        }
    }
}
