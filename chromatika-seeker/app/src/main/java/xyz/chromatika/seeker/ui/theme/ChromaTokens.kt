package xyz.chromatika.seeker.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * chromatika theme tokens that don't fit the material3 shape (palette extras + motion +
 * the active ika base chain). composables consume via `LocalChroma{Palette,Easing,IkaBase}.current`.
 *
 * the m3 `MaterialTheme.{colorScheme,typography,shapes}` is still the source of truth for
 * standard surfaces; these locals layer the chromatika-only bits on top.
 */

/** which ika base chain the wallet is showing. drives palette + shape selection. */
enum class IkaBaseChain { Sui, Solana }

/** chromatika-only color tokens. m3 slots cover the standard surfaces; this exposes the brand
 *  extras (the `ika` coral, the banner severity tints, etc) without polluting m3 semantics. */
@Immutable
data class ChromaPalette(
    val ink: androidx.compose.ui.graphics.Color,
    val surface: androidx.compose.ui.graphics.Color,
    val surface2: androidx.compose.ui.graphics.Color,
    val elevated: androidx.compose.ui.graphics.Color,
    val text: androidx.compose.ui.graphics.Color,
    val muted: androidx.compose.ui.graphics.Color,
    val faint: androidx.compose.ui.graphics.Color,
    val accent: androidx.compose.ui.graphics.Color,
    val accent2: androidx.compose.ui.graphics.Color,
    val ika: androidx.compose.ui.graphics.Color,
    val border: androidx.compose.ui.graphics.Color,
    val borderStrong: androidx.compose.ui.graphics.Color,
)

/** master easing curve. mirrors `theme.css` `--ch-ease: cubic-bezier(0.22, 1, 0.36, 1)`.
 *  every chromatika transition uses this; do not introduce another curve without a reason. */
val ChromaEase: Easing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

val LocalIkaBaseChain = staticCompositionLocalOf { IkaBaseChain.Sui }
val LocalChromaPalette = staticCompositionLocalOf<ChromaPalette> { error("ChromaPalette not provided") }
val LocalChromaShapes = staticCompositionLocalOf<ChromaShapeTokens> { error("ChromaShapeTokens not provided") }
val LocalChromaEasing = staticCompositionLocalOf<Easing> { ChromaEase }

/** convenience: convert a [ChromaSuiDark] / [ChromaSolanaDark] singleton into a [ChromaPalette]. */
internal fun ChromaPaletteFromSuiDark(): ChromaPalette = ChromaPalette(
    ink = ChromaSuiDark.ink,
    surface = ChromaSuiDark.surface,
    surface2 = ChromaSuiDark.surface2,
    elevated = ChromaSuiDark.elevated,
    text = ChromaSuiDark.text,
    muted = ChromaSuiDark.muted,
    faint = ChromaSuiDark.faint,
    accent = ChromaSuiDark.accent,
    accent2 = ChromaSuiDark.accent2,
    ika = ChromaSuiDark.ika,
    border = ChromaSuiDark.border,
    borderStrong = ChromaSuiDark.borderStrong,
)

internal fun ChromaPaletteFromSolanaDark(): ChromaPalette = ChromaPalette(
    ink = ChromaSolanaDark.ink,
    surface = ChromaSolanaDark.surface,
    surface2 = ChromaSolanaDark.surface2,
    elevated = ChromaSolanaDark.elevated,
    text = ChromaSolanaDark.text,
    muted = ChromaSolanaDark.muted,
    faint = ChromaSolanaDark.faint,
    accent = ChromaSolanaDark.accent,
    accent2 = ChromaSolanaDark.accent2,
    ika = ChromaSolanaDark.ika,
    border = ChromaSolanaDark.border,
    borderStrong = ChromaSolanaDark.borderStrong,
)
