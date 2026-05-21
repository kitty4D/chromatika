package xyz.chromatika.seeker.chains.solana

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * solana legacy-transaction wire encoder. hand-rolled because the
 * `com.solanamobile:web3-solana` 0.2.5 builder doesn't expose the signed-tx assembly path
 * cleanly enough for our needs, and the wire format is well-defined.
 *
 * legacy tx layout (`@solana/web3.js` source of truth):
 *
 * ```
 * Transaction = [
 *   compact_array<Signature>     // each 64 bytes (ed25519 sig)
 *   Message
 * ]
 *
 * Message = [
 *   MessageHeader (3 bytes)      // numRequiredSignatures + numReadonlySigned + numReadonlyUnsigned
 *   compact_array<PublicKey>     // each 32 bytes, sorted by signer / writable buckets
 *   RecentBlockhash              // 32 bytes
 *   compact_array<CompiledInstruction>
 * ]
 *
 * CompiledInstruction = [
 *   programIdIndex (u8)
 *   compact_array<AccountIndex (u8)>
 *   compact_array<u8>            // instruction data
 * ]
 * ```
 *
 * `compact_array<T>` = `shortvec` length prefix + the T items packed contiguously.
 *
 * **what the user signs**: the serialized [Message] bytes (the second half of the tx).
 * we sign those, then prepend the signatures section to produce the final [serialize] output.
 */

/* ----------------------------------------------------------------------------
 * primitives
 * ---------------------------------------------------------------------------- */

/** solana's "compact-u16" shortvec: 1-3 bytes encoding a u16 in 7-bit-continuation form. */
internal fun encodeCompactU16(value: Int): ByteArray {
    require(value in 0..0xFFFF) { "compact-u16 value out of range: $value" }
    val out = ByteArrayOutputStream(3)
    var v = value
    while (true) {
        val low = v and 0x7F
        v = v ushr 7
        if (v == 0) {
            out.write(low)
            return out.toByteArray()
        }
        out.write(low or 0x80)
    }
}

private fun ByteArrayOutputStream.writeU32Le(value: Int) {
    val buf = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()
    write(buf, 0, 4)
}

private fun ByteArrayOutputStream.writeU64Le(value: Long) {
    val buf = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(value).array()
    write(buf, 0, 8)
}

/* ----------------------------------------------------------------------------
 * solana transaction data classes
 * ---------------------------------------------------------------------------- */

/**
 * one account a tx references. `isSigner` accounts must produce a matching signature in the
 * signatures section. `isWritable` accounts can be modified by the program. ordering matters:
 * the message accounts list is built by sorting (signer + writable) before (signer +
 * readonly) before (non-signer + writable) before (non-signer + readonly).
 */
data class AccountMeta(
    /** 32-byte ed25519 public key. */
    val pubkey: ByteArray,
    val isSigner: Boolean,
    val isWritable: Boolean,
) {
    init {
        require(pubkey.size == 32) { "AccountMeta pubkey must be 32 bytes (got ${pubkey.size})" }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AccountMeta) return false
        return pubkey.contentEquals(other.pubkey) && isSigner == other.isSigner && isWritable == other.isWritable
    }

    override fun hashCode(): Int {
        var result = pubkey.contentHashCode()
        result = 31 * result + isSigner.hashCode()
        result = 31 * result + isWritable.hashCode()
        return result
    }
}

/** one solana instruction: program + accounts (by reference) + raw data. */
data class Instruction(
    val programId: ByteArray,
    val accounts: List<AccountMeta>,
    val data: ByteArray,
) {
    init {
        require(programId.size == 32) { "programId must be 32 bytes" }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Instruction) return false
        return programId.contentEquals(other.programId) &&
            accounts == other.accounts &&
            data.contentEquals(other.data)
    }

    override fun hashCode(): Int {
        var result = programId.contentHashCode()
        result = 31 * result + accounts.hashCode()
        result = 31 * result + data.contentHashCode()
        return result
    }
}

/* ----------------------------------------------------------------------------
 * message + transaction
 * ---------------------------------------------------------------------------- */

/**
 * a serialized solana message ready to sign. produced by [buildMessage] from a fee payer +
 * the list of [Instruction]s + a recent blockhash. callers sign the result, then call
 * [assembleSignedTransaction] to combine the signature(s) with this message into a final tx.
 */
data class SolanaMessage(
    val numRequiredSignatures: Byte,
    val numReadonlySignedAccounts: Byte,
    val numReadonlyUnsignedAccounts: Byte,
    /** 32-byte pubkeys in the canonical solana ordering: signer+writable, signer+readonly, non-signer+writable, non-signer+readonly. */
    val accountKeys: List<ByteArray>,
    val recentBlockhash: ByteArray,
    val instructions: List<CompiledInstruction>,
) {
    init {
        require(recentBlockhash.size == 32) { "recentBlockhash must be 32 bytes" }
        accountKeys.forEach { require(it.size == 32) { "every account key must be 32 bytes" } }
    }

    /** byte-encoded message, ready to be ed25519-signed. */
    fun serialize(): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(numRequiredSignatures.toInt() and 0xFF)
        out.write(numReadonlySignedAccounts.toInt() and 0xFF)
        out.write(numReadonlyUnsignedAccounts.toInt() and 0xFF)

        out.write(encodeCompactU16(accountKeys.size))
        for (key in accountKeys) out.write(key)

        out.write(recentBlockhash)

        out.write(encodeCompactU16(instructions.size))
        for (ix in instructions) {
            out.write(ix.programIdIndex.toInt() and 0xFF)
            out.write(encodeCompactU16(ix.accountIndices.size))
            for (idx in ix.accountIndices) out.write(idx.toInt() and 0xFF)
            out.write(encodeCompactU16(ix.data.size))
            out.write(ix.data)
        }
        return out.toByteArray()
    }
}

data class CompiledInstruction(
    val programIdIndex: Byte,
    val accountIndices: List<Byte>,
    val data: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is CompiledInstruction) return false
        return programIdIndex == other.programIdIndex &&
            accountIndices == other.accountIndices &&
            data.contentEquals(other.data)
    }

    override fun hashCode(): Int {
        var result = programIdIndex.toInt()
        result = 31 * result + accountIndices.hashCode()
        result = 31 * result + data.contentHashCode()
        return result
    }
}

/* ----------------------------------------------------------------------------
 * builders
 * ---------------------------------------------------------------------------- */

/**
 * compile a list of [Instruction]s + a fee payer into a [SolanaMessage] ready to sign.
 *
 *  - [feePayer] is the first account in the message (always signer + writable).
 *  - additional accounts are collected from the instructions, deduplicated, then sorted by
 *    (isSigner desc, isWritable desc) per the solana spec.
 *  - each instruction's account list is then re-indexed to point at positions in the final
 *    message accounts array.
 */
fun buildMessage(
    feePayer: ByteArray,
    instructions: List<Instruction>,
    recentBlockhash: ByteArray,
): SolanaMessage {
    require(feePayer.size == 32) { "feePayer must be 32 bytes" }
    require(recentBlockhash.size == 32) { "recentBlockhash must be 32 bytes" }
    require(instructions.isNotEmpty()) { "transaction must have at least one instruction" }

    // collect every distinct account across the fee payer + every instruction + every program id.
    // we record the strongest privilege seen for each pubkey (signer wins over non-signer, writable wins over readonly).
    val privileges = LinkedHashMap<PubkeyKey, AccountPriv>()
    fun touch(pubkey: ByteArray, isSigner: Boolean, isWritable: Boolean) {
        val k = PubkeyKey(pubkey)
        val prev = privileges[k]
        if (prev == null) {
            privileges[k] = AccountPriv(pubkey, isSigner, isWritable)
        } else {
            privileges[k] = AccountPriv(
                pubkey = pubkey,
                isSigner = prev.isSigner || isSigner,
                isWritable = prev.isWritable || isWritable,
            )
        }
    }
    // fee payer first, always signer + writable.
    touch(feePayer, isSigner = true, isWritable = true)
    for (ix in instructions) {
        for (acc in ix.accounts) touch(acc.pubkey, acc.isSigner, acc.isWritable)
        // program ids are always non-signer + readonly.
        touch(ix.programId, isSigner = false, isWritable = false)
    }

    // canonical solana ordering: signer+writable, signer+readonly, non-signer+writable, non-signer+readonly.
    // within each bucket preserve the order they appeared in (deterministic for the same input).
    val all = privileges.values.toList()
    val ordered = (
        all.filter { it.isSigner && it.isWritable } +
            all.filter { it.isSigner && !it.isWritable } +
            all.filter { !it.isSigner && it.isWritable } +
            all.filter { !it.isSigner && !it.isWritable }
        )

    val numRequiredSignatures = ordered.count { it.isSigner }
    val numReadonlySigned = ordered.count { it.isSigner && !it.isWritable }
    val numReadonlyUnsigned = ordered.count { !it.isSigner && !it.isWritable }

    val accountKeys = ordered.map { it.pubkey }

    // build the indexed instructions
    val keyToIndex: Map<PubkeyKey, Int> = ordered.mapIndexed { idx, p -> PubkeyKey(p.pubkey) to idx }.toMap()
    val compiled = instructions.map { ix ->
        CompiledInstruction(
            programIdIndex = keyToIndex.getValue(PubkeyKey(ix.programId)).toByte(),
            accountIndices = ix.accounts.map { keyToIndex.getValue(PubkeyKey(it.pubkey)).toByte() },
            data = ix.data,
        )
    }

    return SolanaMessage(
        numRequiredSignatures = numRequiredSignatures.toByte(),
        numReadonlySignedAccounts = numReadonlySigned.toByte(),
        numReadonlyUnsignedAccounts = numReadonlyUnsigned.toByte(),
        accountKeys = accountKeys,
        recentBlockhash = recentBlockhash,
        instructions = compiled,
    )
}

/**
 * stitch one or more 64-byte signatures with the serialized message into a final transaction
 * wire blob. signatures must be in the same order as the leading signer accounts in
 * [SolanaMessage.accountKeys]; for a single-signer transfer that means one signature only.
 */
fun assembleSignedTransaction(message: SolanaMessage, signatures: List<ByteArray>): ByteArray {
    require(signatures.size == (message.numRequiredSignatures.toInt() and 0xFF)) {
        "signature count ${signatures.size} doesn't match numRequiredSignatures ${message.numRequiredSignatures}"
    }
    signatures.forEach { require(it.size == 64) { "every signature must be 64 bytes" } }

    val out = ByteArrayOutputStream()
    out.write(encodeCompactU16(signatures.size))
    for (sig in signatures) out.write(sig)
    val messageBytes = message.serialize()
    out.write(messageBytes)
    return out.toByteArray()
}

/* ----------------------------------------------------------------------------
 * internal helpers
 * ---------------------------------------------------------------------------- */

private data class AccountPriv(
    val pubkey: ByteArray,
    val isSigner: Boolean,
    val isWritable: Boolean,
)

/** wraps a `ByteArray` so it can be used as a map / set key. arrays don't equal by content. */
private class PubkeyKey(val bytes: ByteArray) {
    override fun equals(other: Any?): Boolean = other is PubkeyKey && bytes.contentEquals(other.bytes)
    override fun hashCode(): Int = bytes.contentHashCode()
}
