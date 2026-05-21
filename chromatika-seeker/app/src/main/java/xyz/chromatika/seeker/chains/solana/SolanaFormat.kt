package xyz.chromatika.seeker.chains.solana

import java.math.BigDecimal
import java.math.RoundingMode

/**
 * lamport ↔ SOL formatting helpers. solana has 9 decimals (1 SOL = 1_000_000_000 lamports).
 *
 * display rules (mirror the chrome extension's amount-display conventions, modified for
 * mobile readability):
 *
 *  - **default**: trim trailing zeros, cap at 4 significant decimal digits for the integer
 *    portion ≥ 1, 6 decimals for amounts < 1 SOL. e.g. `1.0006` → `1.0006`, `0.001234567` → `0.001234`.
 *  - **compact**: round to the strongest "decoration" position. e.g. `1000.234` → `1,000.23`,
 *    `0.012` → `0.012`, `0.00001` → `<0.001`.
 *  - **exact**: full 9-decimal display. use for confirm screens where precision matters.
 *
 * uses [BigDecimal] internally so we never lose precision against large lamport values
 * (`Long` overflows at ~9.2 billion SOL which can't happen, but the math should still be
 * exact-not-approximate for amounts that fit comfortably).
 */
object SolanaFormat {

    private val LAMPORTS_PER_SOL_BD: BigDecimal = BigDecimal.TEN.pow(9)
    private const val MAX_DEFAULT_DECIMALS_LARGE = 4
    private const val MAX_DEFAULT_DECIMALS_SMALL = 6

    /**
     * default display: trim trailing zeros, scale decimals by magnitude. always returns
     * a plain number with no thousands separator (matches the extension's "0.001234" style).
     *
     *  - amounts ≥ 1 SOL: up to 4 decimal places
     *  - amounts < 1 SOL: up to 6 decimal places
     *  - zero: literal "0"
     *  - sub-dust (< 0.000001 SOL): "<0.000001"
     */
    fun formatSol(lamports: Long): String {
        if (lamports == 0L) return "0"
        val sol = BigDecimal(lamports).divide(LAMPORTS_PER_SOL_BD)
        val maxDecimals = if (sol.compareTo(BigDecimal.ONE) >= 0) MAX_DEFAULT_DECIMALS_LARGE else MAX_DEFAULT_DECIMALS_SMALL
        val scaled = sol.setScale(maxDecimals, RoundingMode.HALF_UP)
        // sub-dust check happens after scaling: if the scaled value rounds to zero, we have dust.
        if (scaled.compareTo(BigDecimal.ZERO) == 0) return "<0.000001"
        return scaled.stripTrailingZeros().toPlainString()
    }

    /**
     * compact display for chart cards / list rows. caps at 2 decimal places for amounts ≥ 1,
     * otherwise uses the default rules.
     */
    fun formatSolCompact(lamports: Long): String {
        if (lamports == 0L) return "0"
        val sol = BigDecimal(lamports).divide(LAMPORTS_PER_SOL_BD)
        return if (sol.compareTo(BigDecimal.ONE) >= 0) {
            sol.setScale(2, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()
        } else {
            formatSol(lamports)
        }
    }

    /** full 9-decimal display. use for confirm screens. */
    fun formatSolExact(lamports: Long): String {
        if (lamports == 0L) return "0"
        return BigDecimal(lamports).divide(LAMPORTS_PER_SOL_BD)
            .setScale(9, RoundingMode.UNNECESSARY)
            .stripTrailingZeros()
            .toPlainString()
    }

    /** parse a user-entered SOL amount string ("0.001") into a lamport count. throws on parse error. */
    fun lamportsFromSol(solString: String): Long {
        val trimmed = solString.trim()
        if (trimmed.isEmpty()) throw NumberFormatException("empty SOL amount")
        val parsed = BigDecimal(trimmed)
        if (parsed.signum() < 0) throw NumberFormatException("negative SOL amount")
        val lamportsBd = parsed.multiply(LAMPORTS_PER_SOL_BD)
        if (lamportsBd.stripTrailingZeros().scale() > 0) {
            throw NumberFormatException("SOL amount has sub-lamport precision (more than 9 decimals)")
        }
        return lamportsBd.longValueExact()
    }
}
