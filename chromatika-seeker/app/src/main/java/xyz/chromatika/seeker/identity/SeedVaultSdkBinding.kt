package xyz.chromatika.seeker.identity

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.net.toUri
import com.solanamobile.seedvault.SigningResponse
import com.solanamobile.seedvault.Wallet
import com.solanamobile.seedvault.WalletContractV1
import kotlinx.coroutines.suspendCancellableCoroutine
import xyz.chromatika.seeker.chains.solana.Base58
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * real seed vault SDK binding. backs [SeedVaultIdentity] when the device is a seeker (or
 * saga, or any android 12+ device with the seed vault simulator installed for dev work).
 *
 * the seed vault SDK lives in `com.solanamobile:seedvault-wallet-sdk`. it surfaces operations
 * as content provider URIs guarded by intent-result flows - "ask the user to authorize the
 * seed", "sign a message with the seed at this derivation path", etc. we keep all activity-
 * result plumbing inside this class and expose suspend functions to the rest of the app.
 *
 * derivation path policy:
 *  - the ika USK derivation message is signed with the **wallet's primary ed25519 key**, i.e.
 *    the account auth token holder. seed vault's `signMessage` returns RFC 8032 deterministic
 *    bytes, so the same seeker on any device yields identical signatures (see
 *    [docs/SEED_VAULT_PARITY.md](../../../../../../docs/SEED_VAULT_PARITY.md)).
 *  - for MWA wallet-side flows (phase 5), we'll use the same auth token but sign per-account
 *    payloads. the derivation policy stays consistent across both surfaces.
 *
 * **phase 1 scope**: this file defines the contract + activity-result wiring. the actual
 * `Wallet.signMessage(...)` call needs an `ActivityResultLauncher` registered before the
 * relevant activity starts, so most usage flows from a setup screen rather than directly.
 * [SeedVaultIdentityFactory] handles the registration boilerplate.
 */
class SeedVaultSdkBinding(
    private val context: Context,
    private val authToken: Long,
    private val accountId: Long,
    private val signMessageLauncher: ActivityResultLauncher<SignMessageRequest>,
    private val accountPublicKey: ByteArray,
) : SeedVaultIdentity {

    override suspend fun solanaPublicKey(): ByteArray = accountPublicKey

    override suspend fun solanaAddressBase58(): String = Base58.encode(accountPublicKey)

    override suspend fun signMessage(message: ByteArray): ByteArray {
        return suspendCancellableCoroutine { cont ->
            val request = SignMessageRequest(
                authToken = authToken,
                accountId = accountId,
                message = message,
            )
            // results land on the launcher's callback, which is wired in
            // [SeedVaultIdentityFactory.registerSignMessage] to resume this continuation.
            // we stash the continuation on the request so the launcher can find it.
            pendingSignContinuation = cont
            try {
                signMessageLauncher.launch(request)
            } catch (e: Throwable) {
                pendingSignContinuation = null
                cont.resumeWithException(e)
            }
        }
    }

    companion object {
        /**
         * package-private slot for the in-flight sign continuation. only one sign at a time;
         * the launcher contract enforces this. **NOT thread-safe across multiple seed-vault
         * accounts in the same activity** - if we ever support more than one paired account
         * concurrently, swap this for a map keyed by request id.
         */
        @Volatile
        internal var pendingSignContinuation: kotlinx.coroutines.CancellableContinuation<ByteArray>? = null
    }
}

/** request payload passed through the activity result contract. */
data class SignMessageRequest(
    val authToken: Long,
    val accountId: Long,
    val message: ByteArray,
)

/**
 * activity result contract that wraps [Wallet.signMessage]. on success returns the raw 64-byte
 * ed25519 signature; on cancel returns `null`; on error throws via the suspend continuation.
 */
class SignMessageContract : ActivityResultContract<SignMessageRequest, ByteArray?>() {

    override fun createIntent(context: Context, input: SignMessageRequest): android.content.Intent {
        return Wallet.signMessage(context, input.authToken, derivationPathForAccount(input.accountId), input.message)
    }

    override fun parseResult(resultCode: Int, intent: android.content.Intent?): ByteArray? {
        if (resultCode != Activity.RESULT_OK || intent == null) return null
        val response: SigningResponse? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(WalletContractV1.EXTRA_SIGNING_RESPONSE, SigningResponse::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(WalletContractV1.EXTRA_SIGNING_RESPONSE)
        }
        return response?.signatures?.firstOrNull()
    }

    private fun derivationPathForAccount(accountId: Long): Uri {
        // canonical solana derivation path: m/44'/501'/<account>'. seed vault parses the URI
        // back into a BipDerivationPath internally; the BIP32 form is the most compact.
        return "bip32:/m/44'/501'/$accountId'".toUri()
    }
}

/**
 * factory + activity-result wiring for [SeedVaultSdkBinding]. call [register] from the
 * activity's `onCreate` so the result launcher is bound before any flow that needs it.
 *
 * usage:
 * ```kotlin
 * class MainActivity : ComponentActivity() {
 *   private lateinit var seedVaultFactory: SeedVaultIdentityFactory
 *   override fun onCreate(savedInstanceState: Bundle?) {
 *     super.onCreate(savedInstanceState)
 *     seedVaultFactory = SeedVaultIdentityFactory.register(this)
 *     // hand seedVaultFactory.openOrAuthorize() to compose later
 *   }
 * }
 * ```
 */
class SeedVaultIdentityFactory private constructor(
    private val activity: ComponentActivity,
    private val signMessageLauncher: ActivityResultLauncher<SignMessageRequest>,
) {

    /**
     * is seed vault even available on this device? false on non-seeker / non-simulator devices.
     * caller falls back to [MnemonicFallbackIdentity] when this returns false.
     */
    fun isAvailable(): Boolean {
        return try {
            val resolver: ContentResolver = activity.contentResolver
            val cursor = resolver.query(
                WalletContractV1.AUTHORIZED_SEEDS_CONTENT_URI,
                arrayOf(WalletContractV1.AUTHORIZED_SEEDS_AUTH_TOKEN),
                null,
                null,
                null,
            )
            cursor?.close()
            true
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * bind to an authorized seed and return a [SeedVaultIdentity]. if no seed is yet authorized
     * for this app, the caller should drive the standard seed vault authorization flow first
     * (out of scope for phase 1; lands in phase 4 when the setup screen materializes).
     *
     * @param authToken seed vault auth token returned by the authorization activity
     * @param accountId numeric account id within the authorized seed (0 = primary)
     * @param accountPublicKey 32-byte ed25519 pubkey for the account (read via content provider)
     */
    fun bind(
        authToken: Long,
        accountId: Long,
        accountPublicKey: ByteArray,
    ): SeedVaultIdentity {
        require(accountPublicKey.size == 32) { "seed vault account pubkey must be 32 bytes" }
        return SeedVaultSdkBinding(
            context = activity,
            authToken = authToken,
            accountId = accountId,
            signMessageLauncher = signMessageLauncher,
            accountPublicKey = accountPublicKey,
        )
    }

    companion object {
        fun register(activity: ComponentActivity): SeedVaultIdentityFactory {
            val launcher = activity.registerForActivityResult(SignMessageContract()) { signature ->
                val cont = SeedVaultSdkBinding.pendingSignContinuation
                SeedVaultSdkBinding.pendingSignContinuation = null
                if (cont == null) return@registerForActivityResult
                if (signature == null) {
                    cont.resumeWithException(SeedVaultUserCancelled())
                } else {
                    cont.resume(signature)
                }
            }
            return SeedVaultIdentityFactory(activity, launcher)
        }
    }
}

class SeedVaultUserCancelled : RuntimeException("seed vault sign cancelled by user")

