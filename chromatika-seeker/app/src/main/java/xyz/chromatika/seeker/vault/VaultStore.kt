package xyz.chromatika.seeker.vault

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * persistence layer for the encrypted vault blob. mirrors the extension's
 * `chromatika.storage.local.get/set('chromatika_vault_v4')` shape but lands in android's
 * DataStore<Preferences>. the **same JSON envelope** is stored, so an extension can in
 * principle drop a v4 blob into the seeker app's datastore (it would still need a
 * compatible envelope) but we do **not** support automated cross-surface blob migration;
 * identity sharing happens at the seed-vault signature layer instead (see SEED_VAULT_PARITY.md).
 *
 * uses Preferences DataStore (not Proto DataStore) because the blob is a single opaque JSON
 * string. richer per-vault metadata (dwallet meta overlay, presign pools, etc.) graduates to
 * Proto DataStore in phase 4 when each store gets its own typed schema.
 */
class VaultStore(private val context: Context) {

    private val ds = context.vaultDataStore

    /** observe the latest stored blob JSON. emits `null` when storage is empty. */
    val blobFlow: Flow<String?> = ds.data.map { prefs: Preferences -> prefs[BLOB_KEY] }

    /** snapshot read. throws nothing; returns null when no blob exists yet. */
    suspend fun read(): String? = blobFlow.first()

    suspend fun write(blobJson: String) {
        // sanity-check shape before writing - never let an unparseable blob land in storage,
        // it'd brick the next launch.
        VaultBlobJson.decode(blobJson)
        ds.edit { prefs -> prefs[BLOB_KEY] = blobJson }
    }

    suspend fun clear() {
        ds.edit { prefs -> prefs.remove(BLOB_KEY) }
    }

    companion object {
        /**
         * matches the extension's storage key naming convention (`chromatika_vault_v4`).
         * pre-release: no migration from prior versions. if we ever change the JSON shape,
         * bump to `_v5` here and clear extension storage instructions go in the changelog.
         */
        val BLOB_KEY = stringPreferencesKey("chromatika_vault_v4")
    }
}

private val Context.vaultDataStore by preferencesDataStore(name = "chromatika_vault")
