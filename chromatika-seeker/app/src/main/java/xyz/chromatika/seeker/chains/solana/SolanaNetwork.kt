package xyz.chromatika.seeker.chains.solana

/**
 * the three solana clusters we care about. mirrors `wallet-extension/src/background/chains/`
 * solana cluster constants. mainnet is the only one that takes real value; devnet + testnet
 * stay sandboxed and are the default during pre-alpha.
 */
enum class SolanaCluster(val rpcUrl: String, val explorerCluster: String) {
    Mainnet(rpcUrl = "https://api.mainnet-beta.solana.com", explorerCluster = "mainnet-beta"),
    Devnet(rpcUrl = "https://api.devnet.solana.com", explorerCluster = "devnet"),
    Testnet(rpcUrl = "https://api.testnet.solana.com", explorerCluster = "testnet"),
    ;

    val explorerHost: String = "https://explorer.solana.com"
    fun txExplorerUrl(signature: String): String = "$explorerHost/tx/$signature?cluster=$explorerCluster"
}

/** lamports per SOL. avoids magic numbers at call sites. */
const val LAMPORTS_PER_SOL: Long = 1_000_000_000L
