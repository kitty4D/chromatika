package xyz.chromatika.seeker.chains.solana

import xyz.chromatika.seeker.identity.SeedVaultIdentity

/**
 * planned native SOL transfer via seed vault. **today this file is a contract sketch**:
 * it declares the call shape so the rest of the app can depend on it, but throws
 * `NotImplementedError` until the next iteration wires it against a real seeker / saga
 * (or seed vault simulator on android 12+).
 *
 * the right wiring needs three things we can only verify against a device:
 *   1. the actual `com.solanamobile:rpc-solana` artifact (or the rolled-up
 *      `com.solanamobile:solana-kotlin` BoM, when published). `rpc-core` 0.2.11 ships only
 *      json-rpc primitives, not the higher-level `SolanaRpcClient` we want here.
 *   2. the `com.solana.transaction.Transaction` signing path against
 *      `com.solana.programs.SystemProgram.transfer(...)`. the wire layout for a signed
 *      legacy tx is well-defined but the SDK's fluent builder is the spot the kotlin team
 *      is iterating fastest on; lock it in once we've smoke-tested the round-trip.
 *   3. the seed vault sign intent flow end-to-end (we exercise it through [SeedVaultIdentity]
 *      already, but only validation against a real device confirms tx-bytes parity).
 *
 * importing this class from compose / UI today is fine; the build compiles. **calling**
 * [send] throws and surfaces the operation-progress banner with an actionable error so the
 * user knows we're not silently swallowing.
 */
class SolanaSendNative(
    @Suppress("unused") private val cluster: SolanaCluster = SolanaCluster.Devnet,
) {

    /**
     * intended contract: build a native SOL transfer, ask [identity] to sign the message
     * bytes via seed vault, broadcast through the solana rpc client, return the base58
     * signature for the explorer link.
     *
     * @throws NotImplementedError today, until phase 3 of the port pass.
     */
    @Suppress("UNUSED_PARAMETER")
    suspend fun send(
        identity: SeedVaultIdentity,
        recipientBase58: String,
        lamports: Long,
    ): String {
        throw NotImplementedError(
            "SolanaSendNative.send lands in phase 3 after the kotlin sdk lockdown + a real " +
                "seeker round-trip. tracking: docs/ARCHITECTURE.md phase 3 chain clients table.",
        )
    }
}
