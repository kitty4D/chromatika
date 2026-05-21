package xyz.chromatika.seeker.chains.solana

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpRequestRetry
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicLong

/**
 * minimal solana JSON-RPC client. wraps ktor-client-okhttp + kotlinx-serialization for the
 * four methods we need today:
 *
 *  - [getBalance]: lamports for an address (no auth, public RPC).
 *  - [getLatestBlockhash]: blockhash + lastValidBlockHeight for tx construction.
 *  - [sendTransaction]: broadcast a base64-encoded signed transaction.
 *  - [getSignatureStatuses]: poll for tx finality.
 *
 * we deliberately do NOT depend on `com.solanamobile:rpc-core` for this surface - those
 * primitives are JSON-RPC-driver-shaped and require a separate `KtorNetworkDriver` import
 * that's not consistently published. a raw ktor client + a hand-rolled `JsonRpcEnvelope`
 * is two screens of code and lets us swap clusters / add custom headers trivially.
 *
 * **threading**: every suspend function hops to [Dispatchers.IO] so callers can invoke from
 * any context. retries (exponential backoff, 3 attempts) are wired via ktor's
 * [HttpRequestRetry] plugin so transient devnet flakes don't surface as user-visible errors.
 *
 * **lifecycle**: instantiate once per [SolanaCluster] and reuse. the underlying [HttpClient]
 * holds a connection pool; recreating it per call wastes time and file descriptors.
 */
class SolanaRpc(val cluster: SolanaCluster) {

    private val nextId = AtomicLong(1L)

    private val http: HttpClient = HttpClient(OkHttp) {
        install(ContentNegotiation) {
            json(Json {
                ignoreUnknownKeys = true
                explicitNulls = false
            })
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 12_000
            connectTimeoutMillis = 5_000
            socketTimeoutMillis = 12_000
        }
        install(HttpRequestRetry) {
            maxRetries = 2
            retryOnServerErrors(maxRetries = 2)
            retryOnExceptionIf(maxRetries = 2) { _, cause ->
                cause is java.io.IOException
            }
            exponentialDelay()
        }
        expectSuccess = true
    }

    /* ----------------------------------------------------------------------------
     * public RPC methods
     * ---------------------------------------------------------------------------- */

    /**
     * fetch the lamport balance of [addressBase58]. returns 0 for accounts that don't yet
     * exist on chain (solana's `getBalance` returns 0 instead of failing). throws on RPC
     * errors and on network failures that exceed the retry budget.
     */
    suspend fun getBalance(addressBase58: String, commitment: Commitment = Commitment.Confirmed): Long =
        withContext(Dispatchers.IO) {
            val response = rpcCall(
                method = "getBalance",
                params = buildJsonArray {
                    add(JsonPrimitive(addressBase58))
                    add(buildJsonObject { put("commitment", commitment.wire) })
                },
            )
            // result is `{ "context": {...}, "value": <lamports> }`
            val resultObj = response.jsonObject
            val value = resultObj["value"]?.jsonPrimitive?.long
                ?: error("getBalance: missing or non-number value field")
            value
        }

    /**
     * fetch the latest recent blockhash + last valid block height. needed when building a
     * fresh tx; the blockhash anchors the tx to a point in time so validators can reject
     * stale txs.
     */
    suspend fun getLatestBlockhash(commitment: Commitment = Commitment.Confirmed): LatestBlockhash =
        withContext(Dispatchers.IO) {
            val response = rpcCall(
                method = "getLatestBlockhash",
                params = buildJsonArray {
                    add(buildJsonObject { put("commitment", commitment.wire) })
                },
            )
            val value = response.jsonObject["value"]?.jsonObject
                ?: error("getLatestBlockhash: missing value")
            LatestBlockhash(
                blockhash = value["blockhash"]?.jsonPrimitive?.contentOrNull
                    ?: error("getLatestBlockhash: missing blockhash"),
                lastValidBlockHeight = value["lastValidBlockHeight"]?.jsonPrimitive?.long
                    ?: error("getLatestBlockhash: missing lastValidBlockHeight"),
            )
        }

    /**
     * broadcast a signed transaction encoded as base64. returns the signature (base58) the
     * validator assigned. throws on validation / simulation failure.
     */
    suspend fun sendTransaction(signedTxB64: String, skipPreflight: Boolean = false): String =
        withContext(Dispatchers.IO) {
            val response = rpcCall(
                method = "sendTransaction",
                params = buildJsonArray {
                    add(JsonPrimitive(signedTxB64))
                    add(buildJsonObject {
                        put("encoding", "base64")
                        put("skipPreflight", skipPreflight)
                        put("preflightCommitment", Commitment.Confirmed.wire)
                    })
                },
            )
            response.jsonPrimitive.contentOrNull ?: error("sendTransaction: missing signature")
        }

    /**
     * request a devnet / testnet airdrop. mainnet returns an RPC error (-32601 method not
     * found on mainnet-beta's public endpoint, or "airdrop disabled" on other public mains).
     * we surface that error to the caller verbatim.
     */
    suspend fun requestAirdrop(addressBase58: String, lamports: Long): String =
        withContext(Dispatchers.IO) {
            require(lamports > 0) { "airdrop lamports must be positive" }
            val response = rpcCall(
                method = "requestAirdrop",
                params = buildJsonArray {
                    add(JsonPrimitive(addressBase58))
                    add(JsonPrimitive(lamports))
                    add(buildJsonObject { put("commitment", Commitment.Confirmed.wire) })
                },
            )
            response.jsonPrimitive.contentOrNull ?: error("requestAirdrop: missing signature")
        }

    /**
     * fetch confirmation status for one or more signatures. returns a parallel list with
     * `null` entries for sigs the cluster hasn't seen yet (still processing or unknown).
     */
    suspend fun getSignatureStatuses(signaturesBase58: List<String>): List<SignatureStatus?> =
        withContext(Dispatchers.IO) {
            val response = rpcCall(
                method = "getSignatureStatuses",
                params = buildJsonArray {
                    add(buildJsonArray { signaturesBase58.forEach { add(JsonPrimitive(it)) } })
                    add(buildJsonObject { put("searchTransactionHistory", true) })
                },
            )
            val values = response.jsonObject["value"]?.jsonArray ?: JsonArray(emptyList())
            values.map { entry ->
                if (entry is JsonObject) {
                    SignatureStatus(
                        slot = entry["slot"]?.jsonPrimitive?.long ?: 0L,
                        confirmations = entry["confirmations"]?.jsonPrimitive?.long,
                        confirmationStatus = entry["confirmationStatus"]?.jsonPrimitive?.contentOrNull,
                        err = entry["err"]?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.toString(),
                    )
                } else null
            }
        }

    /* ----------------------------------------------------------------------------
     * internals
     * ---------------------------------------------------------------------------- */

    private suspend fun rpcCall(method: String, params: JsonArray): JsonElement {
        val req = JsonRpcRequest(
            jsonrpc = "2.0",
            id = nextId.getAndIncrement(),
            method = method,
            params = params,
        )
        val res: JsonRpcResponse = http.post(cluster.rpcUrl) {
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()
        if (res.error != null) {
            throw SolanaRpcException(
                code = res.error.code,
                message = res.error.message,
                method = method,
            )
        }
        return res.result ?: error("RPC response missing both result and error for method=$method")
    }

    fun close() {
        http.close()
    }
}

/* ----------------------------------------------------------------------------
 * wire envelopes
 * ---------------------------------------------------------------------------- */

@Serializable
private data class JsonRpcRequest(
    val jsonrpc: String,
    val id: Long,
    val method: String,
    val params: JsonArray,
)

@Serializable
private data class JsonRpcResponse(
    val jsonrpc: String = "2.0",
    val id: Long? = null,
    val result: JsonElement? = null,
    val error: JsonRpcError? = null,
)

@Serializable
private data class JsonRpcError(
    val code: Int,
    val message: String,
    @SerialName("data") val data: JsonElement? = null,
)

/* ----------------------------------------------------------------------------
 * public types
 * ---------------------------------------------------------------------------- */

/** solana commitment level. matches the wire literals JSON-RPC expects. */
enum class Commitment(val wire: String) {
    Processed("processed"),
    Confirmed("confirmed"),
    Finalized("finalized"),
}

/** latest recent blockhash + the block height after which it expires. */
data class LatestBlockhash(
    val blockhash: String,
    val lastValidBlockHeight: Long,
)

/** confirmation snapshot for a single signature. */
data class SignatureStatus(
    val slot: Long,
    val confirmations: Long?,
    /** "processed" | "confirmed" | "finalized" */
    val confirmationStatus: String?,
    /** stringified error JSON if the tx failed on chain; null on success. */
    val err: String?,
)

/** thrown when the validator returned an `error` envelope (not a network failure). */
class SolanaRpcException(
    val code: Int,
    override val message: String,
    val method: String,
) : RuntimeException("solana rpc $method failed [$code]: $message")
