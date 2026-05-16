package xyz.chromatika.seeker.vault

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * shape parity tests for vault blob JSON. these run on the JVM (no android device needed),
 * so they catch wire-format drift without requiring an emulator.
 *
 * NB: `android.util.Base64` is android-only. for full encrypt/decrypt round-trip tests we
 * need a robolectric or instrumented suite, which lands when the build is actually wired
 * end-to-end. these tests cover the pure-kotlinx-serialization shape contract.
 */
class VaultBlobJsonTest {

    @Test
    fun `v3 round-trips through canonical JSON`() {
        val blob = VaultBlob.V3(
            salt = "AAECAwQFBgcICQoLDA0ODw==",
            t = 3,
            m = 65_536,
            p = 4,
            iv = "AAECAwQFBgcICQoL",
            data = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        )
        val json = VaultBlobJson.encodeV3(blob)
        val decoded = VaultBlobJson.decodeV3(json)
        assertEquals(blob, decoded)
    }

    @Test
    fun `v4 round-trips with a password envelope`() {
        val env = VaultEnvelope.Password(
            id = "env-pw-1",
            label = "password",
            addedAtEpochMs = 1_700_000_000_000L,
            wrapIv = "AAECAwQFBgcICQoL",
            wrappedMasterKey = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            salt = "MDAxMDIwMzA0MDUwNjA3MA==",
            t = 3,
            m = 65_536,
            p = 4,
        )
        val blob = VaultBlob.V4(
            envelopes = listOf(env),
            iv = "AAECAwQFBgcICQoL",
            data = "ciphertextciphertextciphertextciphertext",
        )
        val json = VaultBlobJson.encode(blob)
        val decoded = VaultBlobJson.decodeV4(json)
        assertEquals(blob, decoded)
    }

    @Test
    fun `v4 round-trips with all four envelope kinds`() {
        val pw = VaultEnvelope.Password(
            id = "env-pw", label = "password", addedAtEpochMs = 1L,
            wrapIv = "AAAAAAAAAAAAAAAA", wrappedMasterKey = "AAAA",
            salt = "AAAAAAAAAAAAAAAA", t = 3, m = 65536, p = 4,
        )
        val passkey = VaultEnvelope.PasskeyPrf(
            id = "env-passkey", label = "passkey", addedAtEpochMs = 2L,
            wrapIv = "AAAAAAAAAAAAAAAA", wrappedMasterKey = "AAAA",
            credentialIdB64Url = "cred-id", rpId = "xyz.chromatika.seeker", prfSaltB64 = "salt-32",
        )
        val seeker = VaultEnvelope.WalletSignature(
            id = "env-seeker", label = "seeker", addedAtEpochMs = 3L,
            wrapIv = "AAAAAAAAAAAAAAAA", wrappedMasterKey = "AAAA",
            source = "seeker", address = "SoMeBaSe58SolanaAddressXxx", hint = "main",
        )
        val recovery = VaultEnvelope.RecoveryWords(
            id = "env-recovery", label = "24-word phrase", addedAtEpochMs = 4L,
            wrapIv = "AAAAAAAAAAAAAAAA", wrappedMasterKey = "AAAA",
            wordCount = 24,
        )
        val blob = VaultBlob.V4(
            envelopes = listOf(pw, passkey, seeker, recovery),
            iv = "AAECAwQFBgcICQoL",
            data = "data-blob",
        )
        val json = VaultBlobJson.encode(blob)
        val decoded = VaultBlobJson.decodeV4(json)
        assertEquals(blob, decoded)
    }

    @Test
    fun `detectVersion picks v3 vs v4`() {
        val v3Json = """{"v":3,"kdf":"argon2id","salt":"","t":3,"m":65536,"p":4,"iv":"","data":""}"""
        val v4Json = """{"v":4,"envelopes":[],"iv":"","data":""}"""
        assertEquals(3, VaultBlobJson.detectVersion(v3Json))
        assertEquals(4, VaultBlobJson.detectVersion(v4Json))
        assertEquals(null, VaultBlobJson.detectVersion("not json"))
    }

    @Test
    fun `legacy PBKDF2 blob surfaces clear migration error`() {
        // pre-release: PBKDF2 blobs (iterations field, missing v) are rejected with a clear
        // message telling the user to clear chromatika storage and onboard again.
        val pbkdf2Json = """{"iterations":900000,"salt":"","iv":"","data":""}"""
        val err = assertThrows(IllegalArgumentException::class.java) {
            VaultBlobJson.decode(pbkdf2Json)
        }
        assertNotNull(err.message)
        assertTrue(err.message!!.contains("Legacy PBKDF2"))
    }

    @Test
    fun `v3 rejects wrong kdf`() {
        val badKdfJson = """{"v":3,"kdf":"scrypt","salt":"","t":3,"m":65536,"p":4,"iv":"","data":""}"""
        assertThrows(IllegalArgumentException::class.java) {
            VaultBlobJson.decodeV3(badKdfJson)
        }
    }

    @Test
    fun `passwordKdfMetaFromV4 finds the first password envelope`() {
        val env = VaultEnvelope.Password(
            id = "env-pw-1", label = "password", addedAtEpochMs = 1L,
            wrapIv = "AAAAAAAAAAAAAAAA", wrappedMasterKey = "AAAA",
            salt = "uniqueSalt", t = 3, m = 65536, p = 4,
        )
        val blob = VaultBlob.V4(envelopes = listOf(env), iv = "", data = "")
        val meta = VaultBlobJson.passwordKdfMetaFromV4(blob)
        assertNotNull(meta)
        assertEquals("uniqueSalt", meta!!.salt)
        assertEquals(3, meta.t)
        assertEquals(65_536, meta.m)
        assertEquals(4, meta.p)
    }

    @Test
    fun `passwordKdfMetaFromV4 returns null when no password envelope`() {
        val seeker = VaultEnvelope.WalletSignature(
            id = "env-seeker", label = "seeker", addedAtEpochMs = 1L,
            wrapIv = "", wrappedMasterKey = "",
            source = "seeker", address = "addr",
        )
        val blob = VaultBlob.V4(envelopes = listOf(seeker), iv = "", data = "")
        assertEquals(null, VaultBlobJson.passwordKdfMetaFromV4(blob))
    }

    @Test
    fun `argon2id params constants match extension`() {
        assertEquals(3, Argon2idParams.T)
        assertEquals(65_536, Argon2idParams.M_KIB)
        assertEquals(4, Argon2idParams.P)
        assertEquals(32, Argon2idParams.DK_LEN)
        assertEquals(16, Argon2idParams.SALT_LEN)
        assertEquals(12, Argon2idParams.IV_LEN)
        assertEquals(256, Argon2idParams.KEY_LEN_BITS)
    }

    @Test
    fun `hkdf info strings match extension byte for byte`() {
        // tripwire: if anyone tweaks the v1 suffix, every v4 wallet-signature / passkey-prf /
        // recovery-words envelope in the field instantly stops unlocking. catch the drift here.
        assertEquals("chromatika.envelope.passkey-prf.v1", EnvelopeKekInfo.PASSKEY)
        assertEquals("chromatika.envelope.wallet-signature.v1", EnvelopeKekInfo.WALLET_SIG)
        assertEquals("chromatika.envelope.recovery-words.v1", EnvelopeKekInfo.RECOVERY)
    }
}
