package xyz.chromatika.seeker.vault

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * canonical JSON for [VaultBlob]. uses kotlinx.serialization with permissive decoding to match
 * the extension's `JSON.parse`-tolerant behavior (extra fields are ignored, but required fields
 * fail loudly).
 *
 * always round-trips through this object - never plain `Json.encodeToString(...)` - so the
 * blob shape stays stable across producers and consumers (extension + seeker app).
 */
object VaultBlobJson {

    val json: Json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
        classDiscriminator = "kind"
        // keep field order stable for deterministic blobs; helps unlock-cache equality checks
        prettyPrint = false
    }

    fun encode(blob: VaultBlob.V4): String = json.encodeToString(VaultBlob.V4.serializer(), blob)

    fun encodeV3(blob: VaultBlob.V3): String = json.encodeToString(VaultBlob.V3.serializer(), blob)

    /**
     * detect blob version without throwing. used so we can route the parse to the right
     * decoder before incurring its strict-shape errors.
     */
    fun detectVersion(blobJson: String): Int? {
        return try {
            val root = json.parseToJsonElement(blobJson) as? JsonObject ?: return null
            val v = root["v"] as? JsonPrimitive ?: return null
            v.intOrNull
        } catch (_: Throwable) {
            null
        }
    }

    fun decodeV3(blobJson: String): VaultBlob.V3 {
        // legacy detector: PBKDF2 vaults shipped before v3 land here and we surface a clear
        // error so users know to clear extension storage and re-onboard (pre-release policy).
        val root = json.parseToJsonElement(blobJson) as? JsonObject
            ?: throw IllegalArgumentException("Invalid vault blob: not a JSON object")
        val v = (root["v"] as? JsonPrimitive)?.intOrNull
        if (v != 3) {
            val hasIterations = root["iterations"] != null
            if (v == null || hasIterations) {
                throw IllegalArgumentException(
                    "Legacy PBKDF2 vault detected. Pre-release: clear chromatika storage and onboard again.",
                )
            }
            throw IllegalArgumentException("Unsupported vault blob version: $v")
        }
        val kdf = (root["kdf"] as? JsonPrimitive)?.contentOrNull
        if (kdf != "argon2id") {
            throw IllegalArgumentException("Unsupported vault KDF: $kdf")
        }
        return json.decodeFromJsonElement(VaultBlob.V3.serializer(), root)
    }

    fun decodeV4(blobJson: String): VaultBlob.V4 {
        val root = json.parseToJsonElement(blobJson) as? JsonObject
            ?: throw IllegalArgumentException("Invalid vault blob: not a JSON object")
        val v = (root["v"] as? JsonPrimitive)?.intOrNull
        if (v != 4) throw IllegalArgumentException("Not a v4 vault blob (v=$v)")
        if (root["envelopes"] == null || root["iv"] == null || root["data"] == null) {
            throw IllegalArgumentException("Invalid v4 blob shape")
        }
        return json.decodeFromJsonElement(VaultBlob.V4.serializer(), root)
    }

    /** discriminate + decode in one step. returns either [VaultBlob.V3] or [VaultBlob.V4]. */
    fun decode(blobJson: String): VaultBlob {
        return when (detectVersion(blobJson)) {
            3 -> decodeV3(blobJson)
            4 -> decodeV4(blobJson)
            else -> {
                // surface the v3 error so the user gets the migration message.
                try {
                    decodeV3(blobJson)
                } catch (e: IllegalArgumentException) {
                    throw e
                }
            }
        }
    }

    /**
     * read only the password-envelope KDF meta from a v4 blob without unwrapping any envelope.
     * used by the unlock screen to call argon2id with the right salt + params.
     */
    fun passwordKdfMetaFromV4(blob: VaultBlob.V4): KdfMeta? {
        val pw = blob.envelopes.filterIsInstance<VaultEnvelope.Password>().firstOrNull() ?: return null
        return KdfMeta(salt = pw.salt, t = pw.t, m = pw.m, p = pw.p)
    }
}

/** minimal KDF meta used internally by [VaultCrypto]. mirrors the extension's `VaultKdfMeta`. */
data class KdfMeta(
    val salt: String,
    val t: Int = Argon2idParams.T,
    val m: Int = Argon2idParams.M_KIB,
    val p: Int = Argon2idParams.P,
) {
    val kdf: String = "argon2id"
}
