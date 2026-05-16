package xyz.chromatika.seeker.vault

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * structured vault payload that lands inside the AES-GCM-encrypted v4 blob. mirrors the
 * extension's `chromatika_vault_v3.vaults[*]` shape conceptually, scoped down to what the
 * seeker app currently understands. owns:
 *
 *  - `accounts`: the user's signing identities. each carries its source (in-vault seed,
 *    on-device seed vault, imported privkey, mnemonic-derived, or ika-derived). today only
 *    `IN_VAULT` is fully wired - the others are reserved enum values so the schema doesn't
 *    have to change when the seeker / mnemonic / ika paths land.
 *  - `activeAccountId`: which account the wallet home + send flow targets.
 *  - `inVaultEd25519SeedB64`: optional 32-byte ed25519 seed used by every `IN_VAULT` account.
 *    only present when at least one in-vault account exists. zeroed when the vault locks.
 *
 * pre-release note from `CLAUDE.md`: schema breaks are allowed without migrations. when we
 * bump `v`, document the breaking dev step (clear storage + re-onboard) in the changelog.
 */
@Serializable
data class VaultPayload(
    val v: Int = SCHEMA_V,
    val createdAtEpochMs: Long,
    val accounts: List<AccountRecord> = emptyList(),
    val activeAccountId: String? = null,
    /** base64 (no-wrap) of the 32-byte in-vault ed25519 seed used by [AccountSource.InVault] accounts. */
    val inVaultEd25519SeedB64: String? = null,
) {
    init {
        require(v == SCHEMA_V) { "VaultPayload requires v == $SCHEMA_V" }
    }

    /** the active account record, or null when the vault has no accounts. */
    fun activeAccount(): AccountRecord? {
        val id = activeAccountId ?: return null
        return accounts.firstOrNull { it.id == id }
    }

    fun toJson(): String = JSON.encodeToString(serializer(), this)

    companion object {
        const val SCHEMA_V: Int = 1

        /** kotlinx-json instance tuned to match the extension's permissive parse behavior. */
        val JSON: Json = Json {
            encodeDefaults = true
            ignoreUnknownKeys = true
            prettyPrint = false
        }

        fun fromJson(json: String): VaultPayload = JSON.decodeFromString(serializer(), json)

        /** empty payload for a fresh vault (no accounts yet). */
        fun empty(createdAtEpochMs: Long = System.currentTimeMillis()): VaultPayload =
            VaultPayload(createdAtEpochMs = createdAtEpochMs)
    }
}

/**
 * one signing identity in the vault. on the seeker, the user typically has one of each:
 *  - `IN_VAULT` for the password-only path (key bytes live encrypted in the vault payload).
 *  - `SEED_VAULT` for hardware-backed signing via the solana mobile seed vault SDK.
 *  - `MNEMONIC` for restored / imported BIP39 phrases (lands when the mnemonic path ships).
 *  - `IMPORTED` for pasted private keys (developer / testing path).
 *  - `IKA_DERIVED` for downstream ika dWallet accounts (sui-base or solana-base); placeholder.
 *
 * `solanaAddressBase58` is the canonical UI display value. `solanaPublicKeyB64` is the raw
 * 32 bytes so kotlin can pass it directly to RPC / signer code without re-decoding.
 */
@Serializable
data class AccountRecord(
    val id: String,
    val label: String,
    val source: AccountSource,
    val solanaAddressBase58: String,
    /** base64 (no-wrap) of the 32-byte ed25519 public key. */
    val solanaPublicKeyB64: String,
    val createdAtEpochMs: Long,
)

@Serializable
enum class AccountSource {
    InVault,
    SeedVault,
    Mnemonic,
    Imported,
    IkaDerived,
}
