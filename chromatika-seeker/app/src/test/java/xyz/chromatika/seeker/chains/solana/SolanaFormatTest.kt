package xyz.chromatika.seeker.chains.solana

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * lamport ↔ SOL formatter edge cases. these run on the JVM, no android device needed.
 */
class SolanaFormatTest {

    /* ----------------------------------------------------------------------------
     * formatSol (default display)
     * ---------------------------------------------------------------------------- */

    @Test
    fun `zero formats as the literal '0'`() {
        assertEquals("0", SolanaFormat.formatSol(0L))
    }

    @Test
    fun `exactly 1 SOL formats as '1'`() {
        assertEquals("1", SolanaFormat.formatSol(1_000_000_000L))
    }

    @Test
    fun `0,001 SOL round trips`() {
        // 0.001 SOL = 1_000_000 lamports
        assertEquals("0.001", SolanaFormat.formatSol(1_000_000L))
    }

    @Test
    fun `one lamport surfaces as dust marker (rounds below 6 decimals)`() {
        // 1 lamport = 0.000000001 SOL = 1e-9; below 6 decimal precision → "<0.000001"
        assertEquals("<0.000001", SolanaFormat.formatSol(1L))
    }

    @Test
    fun `1000 lamports = 0,000001 SOL still surfaces at minimum precision`() {
        // 1000 lamports = 1e-6 SOL → exactly at the 6-decimal cutoff
        assertEquals("0.000001", SolanaFormat.formatSol(1_000L))
    }

    @Test
    fun `large amounts trim trailing zeros after 4 decimals`() {
        // 1.234567 SOL → caps at 4 decimals → 1.2346 (rounded)
        assertEquals("1.2346", SolanaFormat.formatSol(1_234_567_000L))
    }

    @Test
    fun `whole-SOL amounts drop the trailing zeros`() {
        // 5 SOL exactly → "5", not "5.0000"
        assertEquals("5", SolanaFormat.formatSol(5_000_000_000L))
    }

    @Test
    fun `small amounts keep 6-decimal precision`() {
        // 0.123456789 SOL → caps at 6 decimals → 0.123457 (rounded)
        assertEquals("0.123457", SolanaFormat.formatSol(123_456_789L))
    }

    /* ----------------------------------------------------------------------------
     * formatSolCompact
     * ---------------------------------------------------------------------------- */

    @Test
    fun `compact caps at 2 decimals for amounts above 1 SOL`() {
        assertEquals("1000.23", SolanaFormat.formatSolCompact(1_000_234_000_000L))
    }

    @Test
    fun `compact preserves 6-decimal precision for sub-1-SOL amounts`() {
        assertEquals("0.012", SolanaFormat.formatSolCompact(12_000_000L))
    }

    /* ----------------------------------------------------------------------------
     * formatSolExact (confirm-screen precision)
     * ---------------------------------------------------------------------------- */

    @Test
    fun `exact preserves every lamport`() {
        // 1.000000001 SOL = 1_000_000_001 lamports → must show all 9 decimals
        assertEquals("1.000000001", SolanaFormat.formatSolExact(1_000_000_001L))
    }

    @Test
    fun `exact still trims trailing zeros`() {
        assertEquals("1.5", SolanaFormat.formatSolExact(1_500_000_000L))
    }

    /* ----------------------------------------------------------------------------
     * lamportsFromSol parser
     * ---------------------------------------------------------------------------- */

    @Test
    fun `parses round trip of formatSol output`() {
        assertEquals(1_000_000L, SolanaFormat.lamportsFromSol("0.001"))
        assertEquals(1_000_000_000L, SolanaFormat.lamportsFromSol("1"))
        assertEquals(1_234_500_000L, SolanaFormat.lamportsFromSol("1.2345"))
    }

    @Test
    fun `parses zero`() {
        assertEquals(0L, SolanaFormat.lamportsFromSol("0"))
    }

    @Test
    fun `rejects empty string`() {
        assertThrows(NumberFormatException::class.java) { SolanaFormat.lamportsFromSol("") }
    }

    @Test
    fun `rejects negative`() {
        assertThrows(NumberFormatException::class.java) { SolanaFormat.lamportsFromSol("-1") }
    }

    @Test
    fun `rejects sub-lamport precision`() {
        // 0.0000000001 SOL = 0.1 lamports → not representable
        assertThrows(NumberFormatException::class.java) { SolanaFormat.lamportsFromSol("0.0000000001") }
    }
}
