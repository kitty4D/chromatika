package xyz.chromatika.seeker.chains.solana

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import xyz.chromatika.seeker.identity.SeedVaultIdentity

/**
 * native SOL transfer orchestrator. ports the rough shape of
 * `wallet-extension/src/background/chains/solana-send-native.ts` for kotlin.
 *
 * flow:
 *  1. fetch latest blockhash from [SolanaRpc.getLatestBlockhash].
 *  2. build the transfer message via [SystemProgram.transfer] + [buildMessage].
 *  3. ask the [SeedVaultIdentity] to sign the serialized message bytes (ed25519, 64 bytes out).
 *  4. assemble the signed transaction via [assembleSignedTransaction].
 *  5. base64-encode and submit via [SolanaRpc.sendTransaction].
 *  6. (optional) poll [SolanaRpc.getSignatureStatuses] for confirmation.
 *
 * **safety**: this path signs against whatever [SeedVaultIdentity] the caller hands in. for
 * the password-only vault that's an in-vault ed25519 keypair; for a seeker device it's a seed
 * vault-backed sign. either way, the byte you sign is the canonical solana message + the
 * validator can verify it the same way `solana-keygen sign-data` produces.
 */
class SolanaSendNative(private val rpc: SolanaRpc) {

    /**
     * build, sign, and broadcast a native SOL transfer. returns the broadcast signature
     * (base58). caller can compose [SolanaCluster.txExplorerUrl] for an explorer link.
     */
    suspend fun send(
        identity: SeedVaultIdentity,
        recipientBase58: String,
        lamports: Long,
    ): SendResult = withContext(Dispatchers.IO) {
        require(lamports > 0) { "amount must be positive" }

        val from = identity.solanaPublicKey()
        require(from.size == 32) { "identity pubkey must be 32 bytes" }
        val to = try {
            Base58.decode(recipientBase58)
        } catch (e: Throwable) {
            throw SendValidationException("invalid recipient address: ${e.message ?: "parse failed"}")
        }
        if (to.size != 32) throw SendValidationException("recipient must be a 32-byte solana address (got ${to.size} bytes)")

        val blockhashInfo = rpc.getLatestBlockhash(Commitment.Confirmed)
        val blockhash = Base58.decode(blockhashInfo.blockhash)
        require(blockhash.size == 32) { "blockhash must be 32 bytes after base58 decode" }

        val ix = SystemProgram.transfer(from = from, to = to, lamports = lamports)
        val message = buildMessage(
            feePayer = from,
            instructions = listOf(ix),
            recentBlockhash = blockhash,
        )
        val messageBytes = message.serialize()

        val signature = identity.signMessage(messageBytes)
        require(signature.size == 64) { "ed25519 signature must be 64 bytes (got ${signature.size})" }

        val signedTx = assembleSignedTransaction(message, listOf(signature))
        val signedB64 = Base64.encodeToString(signedTx, Base64.NO_WRAP)
        val sentSignature = rpc.sendTransaction(signedB64, skipPreflight = false)

        SendResult(
            signatureBase58 = sentSignature,
            explorerUrl = rpc.cluster.txExplorerUrl(sentSignature),
            lastValidBlockHeight = blockhashInfo.lastValidBlockHeight,
        )
    }

    /**
     * poll [SolanaRpc.getSignatureStatuses] until the signature reaches at least the requested
     * commitment, or until [timeoutMs] elapses. returns the final status. throws if the tx
     * landed on chain with an error (`status.err != null`).
     */
    suspend fun awaitConfirmation(
        signatureBase58: String,
        target: Commitment = Commitment.Confirmed,
        timeoutMs: Long = 45_000L,
        pollIntervalMs: Long = 1_500L,
    ): SignatureStatus = withContext(Dispatchers.IO) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val statuses = rpc.getSignatureStatuses(listOf(signatureBase58))
            val s = statuses.firstOrNull()
            if (s != null) {
                if (s.err != null) throw SendOnchainException("tx landed with error: ${s.err}", s)
                val reached = matchesOrExceeds(s.confirmationStatus, target)
                if (reached) return@withContext s
            }
            if (System.currentTimeMillis() > deadline) {
                throw SendTimeoutException(
                    "tx not ${target.wire} after ${timeoutMs}ms (signature=$signatureBase58)",
                )
            }
            delay(pollIntervalMs)
        }
        @Suppress("UNREACHABLE_CODE")
        error("unreachable")
    }

    private fun matchesOrExceeds(actual: String?, target: Commitment): Boolean {
        val ordering = listOf(Commitment.Processed, Commitment.Confirmed, Commitment.Finalized)
        val actualIdx = ordering.indexOfFirst { it.wire == actual }
        val targetIdx = ordering.indexOf(target)
        return actualIdx >= 0 && actualIdx >= targetIdx
    }
}

/** result of a successful [SolanaSendNative.send] call. */
data class SendResult(
    val signatureBase58: String,
    val explorerUrl: String,
    /** the block-height beyond which the broadcast tx is dead even if it never landed. */
    val lastValidBlockHeight: Long,
)

/** user-supplied input was invalid (bad recipient, etc). UI should surface inline. */
class SendValidationException(message: String) : RuntimeException(message)

/** tx made it on chain but ran into a runtime error. surface to user with the err string. */
class SendOnchainException(message: String, val status: SignatureStatus) : RuntimeException(message)

/** poll deadline expired without the tx reaching the target commitment. */
class SendTimeoutException(message: String) : RuntimeException(message)
