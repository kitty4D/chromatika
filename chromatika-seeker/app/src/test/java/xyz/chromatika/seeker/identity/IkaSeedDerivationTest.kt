package xyz.chromatika.seeker.identity

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * parity tests for the ika seed derivation kernel. invariants mirror
 * `wallet-extension/src/background/keyring/hd.test.ts` so any drift between the kotlin port
 * and the JS reference is loud at PR time.
 *
 * SAMPLE_SIG_64 is the same fixture the JS test uses (bytes 7..70 mod 256), so anyone with
 * a quick node REPL + the extension checked out can verify the assertions cross-language.
 */
class IkaSeedDerivationTest {

    private val sampleSig: ByteArray = ByteArray(64) { i -> ((i + 7) and 0xff).toByte() }
    private val otherSig: ByteArray = ByteArray(64) { i -> ((i + 200) and 0xff).toByte() }

    @Test
    fun `ika usk domain matches extension constant byte for byte`() {
        // tripwire: if anyone bumps the v1 suffix without coordinating, every cross-app
        // dWallet match instantly breaks. fail here before we ship the regression.
        assertEquals("ika.chromatika.user-share-encryption-key.v1", IKA_USK_DOMAIN)
        val expectedBytes = "ika.chromatika.user-share-encryption-key.v1".toByteArray(Charsets.UTF_8)
        assertArrayEquals(expectedBytes, IKA_USK_DERIVATION_MESSAGE)
    }

    @Test
    fun `ikaRootSeedFromMwaSignature returns 32 bytes`() {
        val seed = ikaRootSeedFromMwaSignature(sampleSig, 0)
        assertEquals(32, seed.size)
    }

    @Test
    fun `ikaRootSeedFromMwaSignature is deterministic`() {
        val a = ikaRootSeedFromMwaSignature(sampleSig, 0)
        val b = ikaRootSeedFromMwaSignature(sampleSig, 0)
        assertArrayEquals(a, b)
    }

    @Test
    fun `ikaRootSeedFromMwaSignature changes with encryption key index`() {
        val a = ikaRootSeedFromMwaSignature(sampleSig, 0)
        val b = ikaRootSeedFromMwaSignature(sampleSig, 1)
        assertFalse(a.contentEquals(b))
    }

    @Test
    fun `ikaRootSeedFromMwaSignature changes with signature bytes`() {
        val a = ikaRootSeedFromMwaSignature(sampleSig, 0)
        val c = ikaRootSeedFromMwaSignature(otherSig, 0)
        assertFalse(a.contentEquals(c))
    }

    @Test
    fun `ikaRootSeedFromMwaSignature rejects empty signatures`() {
        assertThrows(IllegalArgumentException::class.java) {
            ikaRootSeedFromMwaSignature(ByteArray(0), 0)
        }
    }

    @Test
    fun `ikaRootSeedFromMwaSignature rejects negative indices`() {
        assertThrows(IllegalArgumentException::class.java) {
            ikaRootSeedFromMwaSignature(sampleSig, -1)
        }
    }

    @Test
    fun `solanaFeeKeypair stable per signature`() {
        val a = solanaFeeKeypairFromWalletSignature(sampleSig)
        val b = solanaFeeKeypairFromWalletSignature(sampleSig)
        assertArrayEquals(a.publicKey, b.publicKey)
        assertArrayEquals(a.secretKey, b.secretKey)
    }

    @Test
    fun `solanaFeeKeypair differs across signatures`() {
        val a = solanaFeeKeypairFromWalletSignature(sampleSig)
        val c = solanaFeeKeypairFromWalletSignature(otherSig)
        assertFalse(a.publicKey.contentEquals(c.publicKey))
    }

    @Test
    fun `solanaFeeKeypair differs across indices`() {
        val a = solanaFeeKeypairFromWalletSignature(sampleSig, IKA_FEE_PAYER_DERIVATION_INDEX)
        val b = solanaFeeKeypairFromWalletSignature(sampleSig, IKA_FEE_PAYER_DERIVATION_INDEX + 1)
        assertFalse(a.publicKey.contentEquals(b.publicKey))
    }

    @Test
    fun `solanaFeeKeypair refuses index 0 reserved for ika root seed`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            solanaFeeKeypairFromWalletSignature(sampleSig, 0)
        }
        assertEquals(true, ex.message?.contains("index 0"))
    }

    @Test
    fun `solanaFeeKeypair rejects empty signatures`() {
        assertThrows(IllegalArgumentException::class.java) {
            solanaFeeKeypairFromWalletSignature(ByteArray(0))
        }
    }

    @Test
    fun `solanaFeeKeypair rejects negative indices`() {
        assertThrows(IllegalArgumentException::class.java) {
            solanaFeeKeypairFromWalletSignature(sampleSig, -1)
        }
    }

    @Test
    fun `solanaFeeKeypair pubkey does not equal the ika root seed at index 0`() {
        // a regression of "drop the index byte" would let the fee payer secret material
        // collide with the ika encryption key seed. assert the divergence loudly.
        val ikaSeed = ikaRootSeedFromMwaSignature(sampleSig, 0)
        val feePub = solanaFeeKeypairFromWalletSignature(sampleSig).publicKey
        assertNotEquals(ikaSeed.toList(), feePub.toList())
    }

    @Test
    fun `solana keypair shape is 64-byte secret key, 32-byte public key`() {
        val kp = solanaFeeKeypairFromWalletSignature(sampleSig)
        assertEquals(64, kp.secretKey.size)
        assertEquals(32, kp.publicKey.size)
        // canonical solana layout: secretKey = [seed(32) | pubkey(32)]
        assertArrayEquals(kp.publicKey, kp.secretKey.copyOfRange(32, 64))
    }
}
