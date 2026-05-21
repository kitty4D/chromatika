package xyz.chromatika.seeker.data.settings

import xyz.chromatika.seeker.chains.solana.SolanaCluster

/**
 * the seeker app's typed global settings. **read via [SettingsStore.flow]**, written via the
 * suspending setters (one per field). adding a field:
 *  1. add the property here with a default.
 *  2. add the persistent key + serializer in [SettingsStore].
 *  3. add a `setX(...)` method on [SettingsStore].
 *  4. wire callers + write a round-trip test.
 *
 * keep this small. settings that scope to a specific vault (active dWallet selection, etc.)
 * belong in the vault payload, not here.
 */
data class AppSettings(
    /** which solana cluster the wallet talks to for balances + send flow. */
    val solanaCluster: SolanaCluster = SolanaCluster.Mainnet,
)
