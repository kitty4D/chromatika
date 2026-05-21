package xyz.chromatika.seeker.chains.solana

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * solana system program instruction builders. there's a bunch but for the seeker app's
 * V1 demo we only need [transfer]; the rest land when the corresponding UI flows ship.
 *
 * **system program id** is the literal 32 zero bytes (base58 encodes to a string of 32 ones:
 * `11111111111111111111111111111111`). every send is essentially a system-program-transfer
 * instruction wrapped in a tx.
 *
 * docs: [solana system program reference](https://docs.solana.com/runtime/programs#system-program)
 */
object SystemProgram {

    val PROGRAM_ID: ByteArray = ByteArray(32) // all zeros
    const val PROGRAM_ID_BASE58: String = "11111111111111111111111111111111"

    /** discriminator constants for the system program instructions (u32 LE in the data buffer). */
    private const val IX_CREATE_ACCOUNT: Int = 0
    private const val IX_ASSIGN: Int = 1
    private const val IX_TRANSFER: Int = 2
    private const val IX_CREATE_ACCOUNT_WITH_SEED: Int = 3
    private const val IX_ADVANCE_NONCE: Int = 4
    private const val IX_WITHDRAW_NONCE: Int = 5
    private const val IX_INITIALIZE_NONCE: Int = 6
    private const val IX_AUTHORIZE_NONCE: Int = 7
    private const val IX_ALLOCATE: Int = 8

    /**
     * build a native SOL transfer instruction. [from] is debited [lamports] and credited to
     * [to]. both must be solana pubkeys (32 bytes). [from] is signer + writable; [to] is
     * writable.
     *
     * data buffer layout: `u32 LE discriminator (2) || u64 LE amount`. total 12 bytes.
     */
    fun transfer(from: ByteArray, to: ByteArray, lamports: Long): Instruction {
        require(from.size == 32) { "from pubkey must be 32 bytes" }
        require(to.size == 32) { "to pubkey must be 32 bytes" }
        require(lamports > 0) { "lamports must be positive" }

        val data = ByteArrayOutputStream(12).apply {
            val ix = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(IX_TRANSFER).array()
            write(ix, 0, 4)
            val amount = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(lamports).array()
            write(amount, 0, 8)
        }.toByteArray()

        return Instruction(
            programId = PROGRAM_ID,
            accounts = listOf(
                AccountMeta(pubkey = from, isSigner = true, isWritable = true),
                AccountMeta(pubkey = to, isSigner = false, isWritable = true),
            ),
            data = data,
        )
    }
}

/**
 * the standard solana base fee per signature in lamports. one signature = 5000 lamports.
 * priority fees layer on top; we don't add them for V1 sends. surface as the "estimated fee"
 * on the confirm screen.
 */
const val SOLANA_BASE_FEE_LAMPORTS_PER_SIG: Long = 5_000L
