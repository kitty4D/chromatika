package xyz.chromatika.seeker.vault

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * round-trip + shape parity tests for [VaultPayload]. these run on the JVM with no android
 * device, so they pin the JSON wire format every time CI runs unit tests.
 */
class VaultPayloadTest {

    @Test
    fun `schema version constant is stable`() {
        // bumping this is a breaking change; CI rejects until the changelog notes the bump.
        assertEquals(1, VaultPayload.SCHEMA_V)
    }

    @Test
    fun `empty payload round-trips`() {
        val before = VaultPayload.empty(createdAtEpochMs = 1_700_000_000_000L)
        val json = before.toJson()
        val after = VaultPayload.fromJson(json)
        assertEquals(before, after)
        assertEquals(0, after.accounts.size)
        assertNull(after.activeAccountId)
        assertNull(after.inVaultEd25519SeedB64)
    }

    @Test
    fun `payload with in-vault account round-trips and surfaces active account`() {
        val acct = AccountRecord(
            id = "acct-1",
            label = "primary",
            source = AccountSource.InVault,
            solanaAddressBase58 = "FakeAddrXxXxXxXxXxXxXxXxXxXxXxXxXxXxX",
            solanaPublicKeyB64 = "AAAA",
            createdAtEpochMs = 1_700_000_000_100L,
        )
        val before = VaultPayload(
            createdAtEpochMs = 1_700_000_000_000L,
            accounts = listOf(acct),
            activeAccountId = acct.id,
            inVaultEd25519SeedB64 = "MDAxMDIwMzA0MDUwNjA3MA==",
        )
        val after = VaultPayload.fromJson(before.toJson())
        assertEquals(before, after)
        val activeNow = after.activeAccount()
        assertNotNull(activeNow)
        assertEquals(acct, activeNow)
    }

    @Test
    fun `payload with every account source kind round-trips`() {
        val accounts = listOf(
            AccountRecord("a1", "in-vault", AccountSource.InVault, "addr1", "AAAA", 1L),
            AccountRecord("a2", "seeker", AccountSource.SeedVault, "addr2", "AAAA", 2L),
            AccountRecord("a3", "mnemonic", AccountSource.Mnemonic, "addr3", "AAAA", 3L),
            AccountRecord("a4", "imported", AccountSource.Imported, "addr4", "AAAA", 4L),
            AccountRecord("a5", "ika", AccountSource.IkaDerived, "addr5", "AAAA", 5L),
        )
        val before = VaultPayload(createdAtEpochMs = 1L, accounts = accounts, activeAccountId = "a2")
        val after = VaultPayload.fromJson(before.toJson())
        assertEquals(before, after)
        assertEquals(AccountSource.SeedVault, after.activeAccount()?.source)
    }

    @Test
    fun `unknown fields in the JSON are ignored`() {
        // ignoreUnknownKeys = true protects forward compat: an older app must accept a newer
        // app's payload that carries fields it doesn't understand, instead of throwing on parse.
        val json = """
            {
              "v": 1,
              "createdAtEpochMs": 1700000000000,
              "accounts": [],
              "futureField": "ignored",
              "anotherFutureField": {"x": 1}
            }
        """.trimIndent()
        val parsed = VaultPayload.fromJson(json)
        assertEquals(1_700_000_000_000L, parsed.createdAtEpochMs)
    }

    @Test
    fun `activeAccount returns null when activeAccountId is missing or unknown`() {
        val acct = AccountRecord("a1", "x", AccountSource.InVault, "addr", "AAAA", 1L)
        val p1 = VaultPayload(createdAtEpochMs = 1L, accounts = listOf(acct), activeAccountId = null)
        assertNull(p1.activeAccount())
        val p2 = VaultPayload(createdAtEpochMs = 1L, accounts = listOf(acct), activeAccountId = "missing-id")
        assertNull(p2.activeAccount())
    }
}
