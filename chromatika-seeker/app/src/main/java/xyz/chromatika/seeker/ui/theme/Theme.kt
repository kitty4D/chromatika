package xyz.chromatika.seeker.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider

/**
 * chromatika theme entry point. wraps [MaterialTheme] with:
 *  - the right `ColorScheme` for the active ika base chain (dark+sui or dark+solana today;
 *    light variants land when a settings toggle ships).
 *  - the [ChromatikaTypography] using Figtree / Bricolage Grotesque / JetBrains Mono.
 *  - the right [ChromaShapeTokens] (sui rounded vs solana sharp).
 *  - the [LocalChromaPalette] / [LocalChromaShapes] / [LocalChromaEasing] / [LocalIkaBaseChain]
 *    composition locals so chromatika-only tokens (the ika coral, banner tints, ribbon brush)
 *    are reachable from any composable.
 *
 * default base chain is `Sui` - the chromatika canonical surface. callers that need to render
 * a screen as solana-base (e.g. a dWallet detail page for a solana-base dWallet) wrap with
 * `CompositionLocalProvider(LocalIkaBaseChain provides IkaBaseChain.Solana) { ... }`.
 */
@Composable
fun ChromatikaTheme(
    ikaBaseChain: IkaBaseChain = IkaBaseChain.Sui,
    content: @Composable () -> Unit,
) {
    val colorScheme = when (ikaBaseChain) {
        IkaBaseChain.Sui -> chromaSuiDarkScheme()
        IkaBaseChain.Solana -> chromaSolanaDarkScheme()
    }
    val palette = when (ikaBaseChain) {
        IkaBaseChain.Sui -> ChromaPaletteFromSuiDark()
        IkaBaseChain.Solana -> ChromaPaletteFromSolanaDark()
    }
    val shapes = when (ikaBaseChain) {
        IkaBaseChain.Sui -> ChromaSuiShapes
        IkaBaseChain.Solana -> ChromaSolanaShapes
    }
    CompositionLocalProvider(
        LocalIkaBaseChain provides ikaBaseChain,
        LocalChromaPalette provides palette,
        LocalChromaShapes provides shapes,
        LocalChromaEasing provides ChromaEase,
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = ChromatikaTypography,
            shapes = shapes.toMaterialShapes(),
            content = content,
        )
    }
}
