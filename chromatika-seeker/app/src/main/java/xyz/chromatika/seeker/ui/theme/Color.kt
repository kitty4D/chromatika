package xyz.chromatika.seeker.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.graphics.Color
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin

/**
 * chromatika palette materialized from the extension's [`theme.css`](../../../../../../../../../wallet-extension/src/ui/theme.css) `:root`
 * tokens (`--ink`, `--surface`, `--accent`, `--ika`, etc). every token here is the canonical
 * source value expressed as `oklch(L, C, H, A)` and converted into compose `Color` via [oklch].
 *
 * **never hardcode a hex value here** without the originating oklch alongside it - drift between
 * the css source of truth and this file is the whole class of regression we're trying to avoid.
 */

/* ----------------------------------------------------------------------------
 * dark + sui (the chromatika default)
 * ---------------------------------------------------------------------------- */

object ChromaSuiDark {
    val ink: Color = oklch(0.18, 0.04, 280.0)             // page / popup root
    val surface: Color = oklch(0.22, 0.045, 285.0)        // card surface
    val surface2: Color = oklch(0.27, 0.05, 282.0)        // elevated surface
    val elevated: Color = oklch(0.32, 0.055, 280.0, 0.55) // modal sheet
    val text: Color = oklch(0.93, 0.02, 260.0)            // body
    val muted: Color = oklch(0.78, 0.04, 270.0)           // secondary
    val faint: Color = oklch(0.62, 0.06, 275.0)           // tertiary / placeholder
    val accent: Color = oklch(0.78, 0.14, 245.0)          // sky blue, primary brand
    val accent2: Color = oklch(0.72, 0.18, 290.0)         // vivid violet, secondary brand
    val ika: Color = oklch(0.68, 0.20, 15.0)              // warm coral / red, ika brand
    val border: Color = oklch(0.55, 0.08, 260.0, 0.35)
    val borderStrong: Color = oklch(0.7, 0.12, 250.0, 0.45)
}

/* ----------------------------------------------------------------------------
 * dark + solana (terminal charcoal + mint / violet gas, pre-alpha)
 * ---------------------------------------------------------------------------- */

object ChromaSolanaDark {
    val ink: Color = oklch(0.16, 0.035, 175.0)            // deep emerald-leaning charcoal
    val surface: Color = oklch(0.20, 0.04, 175.0)
    val surface2: Color = oklch(0.25, 0.045, 172.0)
    val elevated: Color = oklch(0.30, 0.05, 170.0, 0.55)
    val text: Color = oklch(0.94, 0.02, 170.0)
    val muted: Color = oklch(0.78, 0.04, 165.0)
    val faint: Color = oklch(0.62, 0.06, 160.0)
    val accent: Color = oklch(0.78, 0.22, 152.0)          // solana mint - primary accent
    val accent2: Color = oklch(0.66, 0.20, 305.0)         // violet sub-accent
    val ika: Color = oklch(0.68, 0.20, 15.0)              // ika brand unchanged
    val border: Color = oklch(0.55, 0.10, 152.0, 0.32)
    val borderStrong: Color = oklch(0.70, 0.14, 152.0, 0.42)
}

/* ----------------------------------------------------------------------------
 * banner severity tints (appearance + chain independent for now)
 *
 * lifted from [`theme.css`](../../../../../../../../../wallet-extension/src/ui/theme.css):
 * `--theme-banner-{error,warn,info,success,running}-{bg,fg}`. dark-only at call sites today;
 * when light-mode banners ship we add overrides next to each token.
 * ---------------------------------------------------------------------------- */

object ChromaBanner {
    val errorBg: Color = Color(0xFFDC2626).copy(alpha = 0.18f)
    val errorFg: Color = Color(0xFFFCA5A5)
    val warnBg: Color = Color(0xFFFBBF24).copy(alpha = 0.18f)
    val warnFg: Color = Color(0xFFFCD34D)
    val infoBg: Color = Color(0xFF3884FA).copy(alpha = 0.16f)
    val infoFg: Color = Color(0xFF93C5FD)
    val successBg: Color = Color(0xFF22C55E).copy(alpha = 0.16f)
    val successFg: Color = Color(0xFF86EFAC)
    val runningBg: Color = Color(0xFF6366F1).copy(alpha = 0.16f)
    val runningFg: Color = Color(0xFFA5B4FC)
}

/* ----------------------------------------------------------------------------
 * material3 color schemes lifted from the tokens above
 *
 * the rest of the codebase calls `MaterialTheme.colorScheme.{primary,surface,onSurface,...}`,
 * so we wire each token into the right m3 slot. composables that need chromatika-only tokens
 * (like the `ika` brand coral or the banner tints) read [ChromaSuiDark] / [ChromaBanner]
 * directly via `LocalChromaPalette.current`.
 * ---------------------------------------------------------------------------- */

internal fun chromaSuiDarkScheme(): ColorScheme = darkColorScheme(
    primary = ChromaSuiDark.accent,
    onPrimary = ChromaSuiDark.ink,
    primaryContainer = ChromaSuiDark.surface2,
    onPrimaryContainer = ChromaSuiDark.text,
    secondary = ChromaSuiDark.accent2,
    onSecondary = ChromaSuiDark.ink,
    secondaryContainer = ChromaSuiDark.surface2,
    onSecondaryContainer = ChromaSuiDark.text,
    tertiary = ChromaSuiDark.ika,
    onTertiary = ChromaSuiDark.ink,
    background = ChromaSuiDark.ink,
    onBackground = ChromaSuiDark.text,
    surface = ChromaSuiDark.surface,
    onSurface = ChromaSuiDark.text,
    surfaceVariant = ChromaSuiDark.surface2,
    onSurfaceVariant = ChromaSuiDark.muted,
    outline = ChromaSuiDark.border,
    outlineVariant = ChromaSuiDark.borderStrong,
    error = ChromaBanner.errorFg,
    onError = ChromaSuiDark.ink,
    errorContainer = ChromaBanner.errorBg,
    onErrorContainer = ChromaBanner.errorFg,
)

internal fun chromaSolanaDarkScheme(): ColorScheme = darkColorScheme(
    primary = ChromaSolanaDark.accent,
    onPrimary = ChromaSolanaDark.ink,
    primaryContainer = ChromaSolanaDark.surface2,
    onPrimaryContainer = ChromaSolanaDark.text,
    secondary = ChromaSolanaDark.accent2,
    onSecondary = ChromaSolanaDark.ink,
    secondaryContainer = ChromaSolanaDark.surface2,
    onSecondaryContainer = ChromaSolanaDark.text,
    tertiary = ChromaSolanaDark.ika,
    onTertiary = ChromaSolanaDark.ink,
    background = ChromaSolanaDark.ink,
    onBackground = ChromaSolanaDark.text,
    surface = ChromaSolanaDark.surface,
    onSurface = ChromaSolanaDark.text,
    surfaceVariant = ChromaSolanaDark.surface2,
    onSurfaceVariant = ChromaSolanaDark.muted,
    outline = ChromaSolanaDark.border,
    outlineVariant = ChromaSolanaDark.borderStrong,
    error = ChromaBanner.errorFg,
    onError = ChromaSolanaDark.ink,
    errorContainer = ChromaBanner.errorBg,
    onErrorContainer = ChromaBanner.errorFg,
)

/* ----------------------------------------------------------------------------
 * OKLCh → sRGB helper
 *
 * faithful to the css `oklch()` function so kotlin values match the canonical tokens.
 * math: OKLCh → OKLab → linear sRGB → gamma-encoded sRGB → compose `Color`.
 * adapted from the [oklab color space spec](https://bottosson.github.io/posts/oklab/).
 * ---------------------------------------------------------------------------- */

fun oklch(l: Double, c: Double, hDegrees: Double, alpha: Double = 1.0): Color {
    val h = hDegrees * PI / 180.0
    val aLab = c * cos(h)
    val bLab = c * sin(h)

    val lLinear = (l + 0.3963377774 * aLab + 0.2158037573 * bLab).pow(3.0)
    val mLinear = (l - 0.1055613458 * aLab - 0.0638541728 * bLab).pow(3.0)
    val sLinear = (l - 0.0894841775 * aLab - 1.2914855480 * bLab).pow(3.0)

    val r = +4.0767416621 * lLinear - 3.3077115913 * mLinear + 0.2309699292 * sLinear
    val g = -1.2684380046 * lLinear + 2.6097574011 * mLinear - 0.3413193965 * sLinear
    val b = -0.0041960863 * lLinear - 0.7034186147 * mLinear + 1.7076147010 * sLinear

    return Color(
        red = gammaEncode(r).toFloat(),
        green = gammaEncode(g).toFloat(),
        blue = gammaEncode(b).toFloat(),
        alpha = alpha.toFloat(),
    )
}

private fun gammaEncode(linear: Double): Double {
    val abs = if (linear < 0.0) 0.0 else if (linear > 1.0) 1.0 else linear
    return if (abs >= 0.0031308) 1.055 * abs.pow(1.0 / 2.4) - 0.055 else 12.92 * abs
}
