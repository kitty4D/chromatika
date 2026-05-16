package xyz.chromatika.seeker.chains.solana

/**
 * minimal base58 encoder / decoder for solana addresses. matches `bs58` JS output (which is
 * what `@solana/web3.js` uses) so addresses round-trip with anything chromatika's chrome
 * extension or web3.js callers produce.
 *
 * intentionally avoids the multimult dependency for this hot path: we only need encode +
 * decode of 32-byte solana pubkeys, and the inline impl is small, allocation-light, and
 * dead-simple to audit.
 */
object Base58 {

    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    private val ALPHABET_CHARS = ALPHABET.toCharArray()
    private val ALPHABET_INDEX = IntArray(128) { -1 }.apply {
        for ((i, c) in ALPHABET_CHARS.withIndex()) this[c.code] = i
    }

    fun encode(input: ByteArray): String {
        if (input.isEmpty()) return ""
        var zeros = 0
        while (zeros < input.size && input[zeros].toInt() == 0) zeros++
        val temp = input.copyOf()
        val encoded = CharArray(input.size * 2)
        var outputStart = encoded.size
        var inputStart = zeros
        while (inputStart < temp.size) {
            encoded[--outputStart] = ALPHABET_CHARS[divmod(temp, inputStart, 256, 58).toInt()]
            if (temp[inputStart].toInt() == 0) inputStart++
        }
        while (outputStart < encoded.size && encoded[outputStart] == ALPHABET_CHARS[0]) outputStart++
        repeat(zeros) { encoded[--outputStart] = ALPHABET_CHARS[0] }
        return String(encoded, outputStart, encoded.size - outputStart)
    }

    fun decode(input: String): ByteArray {
        if (input.isEmpty()) return ByteArray(0)
        val input58 = ByteArray(input.length) { i ->
            val c = input[i]
            val digit = if (c.code < 128) ALPHABET_INDEX[c.code] else -1
            require(digit >= 0) { "invalid base58 character '$c'" }
            digit.toByte()
        }
        var zeros = 0
        while (zeros < input58.size && input58[zeros].toInt() == 0) zeros++
        val decoded = ByteArray(input.length)
        var outputStart = decoded.size
        var inputStart = zeros
        while (inputStart < input58.size) {
            decoded[--outputStart] = divmod(input58, inputStart, 58, 256)
            if (input58[inputStart].toInt() == 0) inputStart++
        }
        while (outputStart < decoded.size && decoded[outputStart].toInt() == 0) outputStart++
        return decoded.copyOfRange(outputStart - zeros, decoded.size)
    }

    private fun divmod(number: ByteArray, firstDigit: Int, base: Int, divisor: Int): Byte {
        var remainder = 0
        for (i in firstDigit until number.size) {
            val digit = number[i].toInt() and 0xff
            val temp = remainder * base + digit
            number[i] = (temp / divisor).toByte()
            remainder = temp % divisor
        }
        return remainder.toByte()
    }
}
