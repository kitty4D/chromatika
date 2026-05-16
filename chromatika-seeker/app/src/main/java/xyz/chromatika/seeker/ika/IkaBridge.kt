package xyz.chromatika.seeker.ika

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * kotlin host that owns the lifetime of the ika JS bundle running inside a `WebView`. acts as
 * a request/response RPC dispatcher: kotlin builds a JSON envelope, ships it via
 * `webview.evaluateJavascript("window.handle(...)")`, and awaits the corresponding reply that
 * JS pushes back through the `chromatikaBridge` `@JavascriptInterface`.
 *
 * **lifetime**: this class is intended to live inside the foreground signing service so it
 * survives screen rotations and lock-screen taps but doesn't keep the activity alive. only
 * one bridge per process - ika SDK has module-scope state we don't want stomped on.
 *
 * **threading**: `WebView` requires the main looper. all `evaluateJavascript` calls hop to
 * `Dispatchers.Main` internally; suspending callers may invoke `send` from any context.
 *
 * **phase scope (today)**: the dispatch + transport is wired. the actual ika JS handlers in
 * `chromatika-seeker/ika-js/src/bridge.ts` still throw `not_implemented` for
 * dkg/presign/sign - that lands in the next iteration alongside @ika.xyz/sdk wiring.
 */
class IkaBridge private constructor(
    private val context: Context,
    private val webView: WebView,
) {

    private val json = Json { ignoreUnknownKeys = true; classDiscriminator = "method" }

    /** in-flight requests keyed by id so the JS callback can resolve the right one. */
    private val pending: ConcurrentHashMap<String, CompletableDeferred<JsonObject>> = ConcurrentHashMap()

    init {
        @SuppressLint("SetJavaScriptEnabled")
        webView.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            domStorageEnabled = true
        }
        webView.addJavascriptInterface(BridgeJsApi(), "chromatikaBridge")
        webView.webViewClient = object : WebViewClient() {}
        webView.loadUrl("file:///android_asset/ika-js/index.html")
    }

    /**
     * issue a JSON-RPC-ish call to the JS bridge. throws when the bridge returns an error
     * envelope or when the call times out (default 30s for slow first-DKG cold paths).
     */
    suspend fun send(method: String, params: JsonObject, timeoutMs: Long = 30_000L): JsonObject {
        val id = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<JsonObject>()
        pending[id] = deferred

        val envelope = buildString {
            append("{\"id\":\"").append(id).append("\",")
            append("\"method\":\"").append(method).append("\",")
            append("\"params\":").append(params.toString())
            append("}")
        }
        withContext(Dispatchers.Main) {
            webView.evaluateJavascript("window.handle(${jsStringLiteral(envelope)})", null)
        }
        val result = withTimeoutOrNull(timeoutMs) { deferred.await() }
        pending.remove(id)
        if (result == null) throw IkaBridgeTimeoutException(method, timeoutMs)
        val ok = (result["ok"] as? JsonPrimitive)?.boolean ?: false
        if (!ok) {
            val err = result["error"]?.jsonObject
            val code = (err?.get("code") as? JsonPrimitive)?.contentOrNull ?: "bridge_error"
            val message = (err?.get("message") as? JsonPrimitive)?.contentOrNull ?: "unknown error"
            throw IkaBridgeException(code, message)
        }
        return result
    }

    /** convenience: ask the bridge to call `ika_init`. caller owns the seed bytes lifecycle. */
    suspend fun init(
        baseChain: String,
        network: String,
        rootSeedBytes: ByteArray,
        suiGraphQlEndpoint: String? = null,
        solanaRpcEndpoint: String? = null,
        solanaIkaGrpcEndpoint: String? = null,
    ) {
        val params = buildJsonObject {
            put("baseChain", baseChain)
            put("network", network)
            put("rootSeedB64", android.util.Base64.encodeToString(rootSeedBytes, android.util.Base64.NO_WRAP))
            suiGraphQlEndpoint?.let { put("suiGraphQlEndpoint", it) }
            solanaRpcEndpoint?.let { put("solanaRpcEndpoint", it) }
            solanaIkaGrpcEndpoint?.let { put("solanaIkaGrpcEndpoint", it) }
        }
        send("ika_init", params)
    }

    /**
     * fenced @JavascriptInterface. the bridge passes a string back via
     * `chromatikaBridge.send(JSON.stringify(result))` and we parse + complete the right
     * pending future here.
     */
    private inner class BridgeJsApi {
        @JavascriptInterface
        fun send(raw: String) {
            val element: JsonElement = try {
                json.parseToJsonElement(raw)
            } catch (_: Throwable) {
                return
            }
            val obj = element as? JsonObject ?: return
            val id = (obj["id"] as? JsonPrimitive)?.contentOrNull ?: return
            pending[id]?.complete(obj)
        }
    }

    companion object {
        /**
         * create an [IkaBridge] hosted inside an offscreen `WebView`. caller (typically the
         * foreground signing service) owns the bridge lifetime and calls `webView.destroy()`
         * on shutdown.
         */
        fun create(context: Context): IkaBridge {
            val webView = WebView(context)
            return IkaBridge(context, webView)
        }
    }
}

class IkaBridgeException(val code: String, override val message: String) : RuntimeException(message)

class IkaBridgeTimeoutException(method: String, timeoutMs: Long) :
    RuntimeException("ika bridge call $method timed out after ${timeoutMs}ms")

/** escape a kotlin string for safe inlining into a JavaScript string literal. */
private fun jsStringLiteral(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (c in s) {
        when (c) {
            '\\' -> sb.append("\\\\")
            '"' -> sb.append("\\\"")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            '\b' -> sb.append("\\b")
            else -> if (c.code < 0x20) sb.append("\\u%04x".format(c.code)) else sb.append(c)
        }
    }
    sb.append('"')
    return sb.toString()
}
