package xyz.chromatika.seeker.ui.theme

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * signature chromatika gradients. **sanctioned uses only** - if the css source of truth
 * marks a token as "wordmark + onboarding hero only", honor that here.
 *
 * lifted from [`theme.css`](../../../../../../../../../wallet-extension/src/ui/theme.css):
 *  - `--ch-bleed-gradient` -> [chromaRibbon]
 *  - `--ch-wordmark-gradient` -> [chromaWordmark]
 *  - `--ch-cta-gradient` -> [chromaCtaGradient]
 */
object ChromaBrush {

    /** 4-stop horizontal ribbon used on header bottom-edge, approval popup top-edge,
     *  modal/sheet top-edge. **do NOT use as a button or card fill** - it's a 1-2 dp
     *  ribbon, period. mirrors the css 90deg form. */
    val chromaRibbon: Brush = Brush.horizontalGradient(
        colors = listOf(
            oklch(0.62, 0.19, 22.0),      // ika red-orange
            oklch(0.58, 0.13, 285.0),     // violet
            oklch(0.70, 0.14, 250.0),     // sky
            oklch(0.62, 0.19, 22.0),      // ika return
        ),
    )

    /** wordmark + onboarding-hero gradient. css 102deg, 3 stops. consume via
     *  `Modifier.background(brush = ChromaBrush.chromaWordmark)` on a `Text` with
     *  appropriate `blendMode` or via `style.brush` on text. */
    val chromaWordmark: Brush = Brush.linearGradient(
        colors = listOf(
            oklch(0.97, 0.02, 270.0),     // cream
            oklch(0.82, 0.12, 285.0),     // violet
            oklch(0.88, 0.16, 22.0),      // coral
        ),
        // 102deg = slightly past horizontal, going down-right
        start = Offset(0f, 0f),
        end = Offset(1000f, 220f),
    )

    /** primary CTA fill. css 135deg, violet -> sky. consume on filled `Button` containers
     *  for the headline action in approval / onboarding flows. */
    val chromaCtaGradient: Brush = Brush.linearGradient(
        colors = listOf(
            oklch(0.72, 0.18, 290.0),     // violet
            oklch(0.78, 0.14, 245.0),     // sky
        ),
        // 135deg = down-right diagonal
        start = Offset(0f, 0f),
        end = Offset(1000f, 1000f),
    )

    /** ambient page-background radial-gradient stack for the dark+sui chrome.
     *  approximation of the css multi-radial layered onto `--theme-sp-root-bg`.
     *  composes as overlapping radial gradients on the root [Box]. */
    fun ambientSuiDark(): List<Brush> = listOf(
        Brush.radialGradient(
            colors = listOf(
                Color(0xFF7C5CFC).copy(alpha = 0.26f),
                Color.Transparent,
            ),
            center = Offset(0.08f * 1000f, -0.08f * 1000f),
            radius = 900f,
        ),
        Brush.radialGradient(
            colors = listOf(
                Color(0xFF14B8A6).copy(alpha = 0.16f),
                Color.Transparent,
            ),
            center = Offset(0.96f * 1000f, 0.04f * 1000f),
            radius = 700f,
        ),
    )

    /** ambient page-background for the dark+solana chrome. mint/violet wash. */
    fun ambientSolanaDark(): List<Brush> = listOf(
        Brush.radialGradient(
            colors = listOf(
                Color(0xFF14F195).copy(alpha = 0.14f),
                Color.Transparent,
            ),
            center = Offset(0.06f * 1000f, -0.06f * 1000f),
            radius = 880f,
        ),
        Brush.radialGradient(
            colors = listOf(
                Color(0xFF9945FF).copy(alpha = 0.10f),
                Color.Transparent,
            ),
            center = Offset(1f * 1000f, 0f),
            radius = 700f,
        ),
    )
}
