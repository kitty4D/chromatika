package xyz.chromatika.seeker.chains.solana

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * pin the solana legacy-tx wire encoder against the spec shape.
 *
 * a single-instruction transfer message has predictable section sizes:
 *
 * ```
 * byte 0..2     header [1, 0, 1]  (1 required sig, 0 readonly signed, 1 readonly unsigned)
 * byte 3        compact-u16 prefix = 3 (3 accounts: from, to, system program)
 * byte 4..35    from pubkey (32)
 * byte 36..67   to pubkey (32)
 * byte 68..99   system program (32 zero bytes)
 * byte 100..131 recent blockhash (32)
 * byte 132      compact-u16 prefix = 1 (1 instruction)
 * byte 133      programIdIndex = 2 (system program is the third account)
 * byte 134      compact-u16 prefix = 2 (2 account indices)
 * byte 135      account index 0 (from)
 * byte 136      account index 1 (to)
 * byte 137      compact-u16 prefix = 12 (data length)
 * byte 138..149 data: u32 LE 2 || u64 LE amount
 * ```
 *
 * total: 150 bytes for the message.
 */
class SolanaTxTest {

    private val from = ByteArray(32) { (0x10 + it).toByte() }
    private val to = ByteArray(32) { (0x40 + it).toByte() }
    private val blockhash = ByteArray(32) { (0x80 + it).toByte() }

    @Test
    fun `compact-u16 encodes small values in one byte`() {
        assertArrayEquals(byteArrayOf(0), encodeCompactU16(0))
        assertArrayEquals(byteArrayOf(1), encodeCompactU16(1))
        assertArrayEquals(byteArrayOf(127), encodeCompactU16(127))
    }

    @Test
    fun `compact-u16 encodes mid values in two bytes`() {
        // 128 → 0x80 0x01
        assertArrayEquals(byteArrayOf(0x80.toByte(), 0x01), encodeCompactU16(128))
        // 16383 → 0xFF 0x7F
        assertArrayEquals(byteArrayOf(0xFF.toByte(), 0x7F), encodeCompactU16(16_383))
    }

    @Test
    fun `compact-u16 encodes max values in three bytes`() {
        // 16384 → 0x80 0x80 0x01
        assertArrayEquals(byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x01), encodeCompactU16(16_384))
        // 65535 → 0xFF 0xFF 0x03
        assertArrayEquals(byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0x03), encodeCompactU16(65_535))
    }

    @Test
    fun `single transfer message lands at the expected section offsets`() {
        val ix = SystemProgram.transfer(from = from, to = to, lamports = 1_000_000L)
        val message = buildMessage(
            feePayer = from,
            instructions = listOf(ix),
            recentBlockhash = blockhash,
        )
        val bytes = message.serialize()
        // total length: 3 (header) + 1 (compact-u16 of 3) + 3*32 (accounts) + 32 (blockhash)
        //              + 1 (compact-u16 of 1) + 1 (programIdIndex) + 1 (compact-u16 of 2) + 2 (acct idx)
        //              + 1 (compact-u16 of 12) + 12 (data)
        // = 3 + 1 + 96 + 32 + 1 + 1 + 1 + 2 + 1 + 12 = 150 bytes
        assertEquals(150, bytes.size)

        // header: 1 required signature, 0 readonly signed, 1 readonly unsigned (system program)
        assertEquals(1.toByte(), bytes[0])
        assertEquals(0.toByte(), bytes[1])
        assertEquals(1.toByte(), bytes[2])

        // 3 accounts in the array
        assertEquals(3.toByte(), bytes[3])

        // accounts in canonical order: signer+writable (from), then non-signer+writable (to),
        // then non-signer+readonly (system program).
        assertArrayEquals(from, bytes.copyOfRange(4, 36))
        assertArrayEquals(to, bytes.copyOfRange(36, 68))
        assertArrayEquals(SystemProgram.PROGRAM_ID, bytes.copyOfRange(68, 100))

        // recent blockhash
        assertArrayEquals(blockhash, bytes.copyOfRange(100, 132))

        // 1 instruction, programIdIndex = 2 (system program is at index 2 in accounts)
        assertEquals(1.toByte(), bytes[132])
        assertEquals(2.toByte(), bytes[133])

        // 2 account indices for the instruction
        assertEquals(2.toByte(), bytes[134])
        assertEquals(0.toByte(), bytes[135])  // from
        assertEquals(1.toByte(), bytes[136])  // to

        // 12 bytes of data
        assertEquals(12.toByte(), bytes[137])

        // discriminator 2 (transfer), little-endian u32
        assertArrayEquals(
            byteArrayOf(0x02, 0x00, 0x00, 0x00),
            bytes.copyOfRange(138, 142),
        )
        // amount 1_000_000 = 0x000F4240 little-endian u64
        assertArrayEquals(
            byteArrayOf(0x40, 0x42, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x00),
            bytes.copyOfRange(142, 150),
        )
    }

    @Test
    fun `assembled signed tx prepends sig count + sig before message`() {
        val ix = SystemProgram.transfer(from = from, to = to, lamports = 1L)
        val message = buildMessage(feePayer = from, instructions = listOf(ix), recentBlockhash = blockhash)
        val fakeSig = ByteArray(64) { (0xCC).toByte() }
        val tx = assembleSignedTransaction(message, listOf(fakeSig))

        // tx layout: 1 byte compact-u16 prefix (sig count = 1), 64 bytes of signature, then the message.
        assertEquals(1 + 64 + 150, tx.size)
        assertEquals(1.toByte(), tx[0])
        assertArrayEquals(fakeSig, tx.copyOfRange(1, 65))
        assertArrayEquals(message.serialize(), tx.copyOfRange(65, tx.size))
    }

    @Test
    fun `building with wrong-length signatures throws`() {
        val ix = SystemProgram.transfer(from = from, to = to, lamports = 1L)
        val message = buildMessage(feePayer = from, instructions = listOf(ix), recentBlockhash = blockhash)
        try {
            assembleSignedTransaction(message, listOf(ByteArray(63)))
            org.junit.Assert.fail("expected IllegalArgumentException for short signature")
        } catch (_: IllegalArgumentException) {
            // ok
        }
    }

    @Test
    fun `building with wrong sig count throws`() {
        val ix = SystemProgram.transfer(from = from, to = to, lamports = 1L)
        val message = buildMessage(feePayer = from, instructions = listOf(ix), recentBlockhash = blockhash)
        try {
            assembleSignedTransaction(message, listOf(ByteArray(64), ByteArray(64)))
            org.junit.Assert.fail("expected IllegalArgumentException for too many sigs")
        } catch (_: IllegalArgumentException) {
            // ok
        }
    }

    @Test
    fun `transfer instruction has the right data shape`() {
        val ix = SystemProgram.transfer(from = from, to = to, lamports = 0xCAFEBABEL)
        assertEquals(12, ix.data.size)
        assertEquals(0x02.toByte(), ix.data[0])
        assertEquals(0x00.toByte(), ix.data[1])
        assertEquals(0x00.toByte(), ix.data[2])
        assertEquals(0x00.toByte(), ix.data[3])
        // 0xCAFEBABE little-endian: BE BA FE CA 00 00 00 00
        assertEquals(0xBE.toByte(), ix.data[4])
        assertEquals(0xBA.toByte(), ix.data[5])
        assertEquals(0xFE.toByte(), ix.data[6])
        assertEquals(0xCA.toByte(), ix.data[7])
    }

    @Test
    fun `transfer rejects zero amount`() {
        try {
            SystemProgram.transfer(from = from, to = to, lamports = 0L)
            org.junit.Assert.fail("expected IllegalArgumentException for zero amount")
        } catch (_: IllegalArgumentException) { /* ok */ }
    }

    @Test
    fun `transfer rejects negative amount`() {
        try {
            SystemProgram.transfer(from = from, to = to, lamports = -1L)
            org.junit.Assert.fail("expected IllegalArgumentException for negative amount")
        } catch (_: IllegalArgumentException) { /* ok */ }
    }

    @Test
    fun `building with duplicate from + to merges privileges, doesn't crash`() {
        // self-transfer: from == to. accounts list has 2 unique pubkeys (self + program),
        // not 3. the self entry is signer + writable.
        val ix = SystemProgram.transfer(from = from, to = from, lamports = 1L)
        val message = buildMessage(feePayer = from, instructions = listOf(ix), recentBlockhash = blockhash)
        // self + system program = 2 accounts
        assertEquals(2, message.accountKeys.size)
        assertEquals(1.toByte(), message.numRequiredSignatures)
        // system program is the only readonly + non-signer
        assertEquals(1.toByte(), message.numReadonlyUnsignedAccounts)
    }
}
