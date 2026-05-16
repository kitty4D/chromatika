package xyz.chromatika.seeker.ui.nav

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * bottom-nav inventory. mirrors the extension's side-panel primary chrome, condensed to the
 * 5 destinations that fit a phone tab bar comfortably. additional pages (`portfolio`,
 * `nfts/kiosk`, `policy vault`, etc.) push on top via [NavRoute.detailRoutes].
 */
enum class NavDestination(
    val route: String,
    val label: String,
    val icon: ImageVector,
) {
    Wallet(route = "wallet", label = "wallet", icon = Icons.Outlined.AccountBalanceWallet),
    Send(route = "send", label = "send", icon = Icons.AutoMirrored.Outlined.Send),
    Activity(route = "activity", label = "activity", icon = Icons.Outlined.History),
    Nfts(route = "nfts", label = "nfts", icon = Icons.Outlined.Image),
    Settings(route = "settings", label = "settings", icon = Icons.Outlined.Settings),
    ;
    companion object {
        val all: List<NavDestination> = entries
    }
}

/** detail routes - reachable from the bottom-nav screens via push navigation. */
object NavRoute {
    const val SETUP = "setup"
    const val UNLOCK = "unlock"

    const val WALLET = "wallet"
    const val SEND = "send"
    const val ACTIVITY = "activity"
    const val NFTS = "nfts"
    const val SETTINGS = "settings"

    const val PORTFOLIO = "portfolio"
    const val DWALLET_PORTFOLIO = "dwallet/portfolio/{dwalletId}"
    const val DWALLET_MANAGEMENT = "dwallet/management"
    const val VAULT_MANAGEMENT = "vault/management"
    const val NETWORK_SELECTOR = "settings/networks"
    const val DAPPS = "dapps"
    const val IKA_STAKING = "ika/staking"
    const val IKA_FEES = "ika/fees"
    const val POLICY_VAULT = "policy-vault"
    const val PAYMENTS = "payments"
    const val AGENTS = "agents"
    const val CHROMA_LAB = "chromalab"
}
