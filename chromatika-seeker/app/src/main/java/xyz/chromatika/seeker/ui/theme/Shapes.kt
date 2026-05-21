package xyz.chromatika.seeker.ui.theme

import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.dp

/**
 * shape tokens for chromatika. **this is where the dual-chain product signal lives**:
 * sui-base gets the rounded chromatika look (22 / 18 / 14 / 10 / 6 dp), solana-base flips
 * to sharp corners (0 dp across) - same shape primitive, just zero radii. lifted from
 * `theme.css` `--theme-radius-*` tokens.
 *
 * the `LocalChromaShapes.current` provider in [ChromaTokens] selects the right set based
 * on the active ika base chain. m3 callers consuming `MaterialTheme.shapes` get whichever
 * variant is active.
 *
 * note: we use [CornerBasedShape] (the m3 [Shapes] constructor's required type), not the
 * broader [androidx.compose.ui.graphics.Shape]. that means even the "sharp" solana variant
 * is `RoundedCornerShape(0.dp)`, not `RectangleShape` - same visual result, but the type
 * matches m3's expectations so `MaterialTheme.shapes.large` etc resolve cleanly.
 */
@Immutable
data class ChromaShapeTokens(
    val panel: CornerBasedShape,
    val surface: CornerBasedShape,
    val control: CornerBasedShape,
    val sm: CornerBasedShape,
    val xs: CornerBasedShape,
    val pill: CornerBasedShape,
) {
    /** map onto m3's [Shapes] so `MaterialTheme.shapes.{extraSmall,small,medium,large,extraLarge}` resolves correctly. */
    fun toMaterialShapes(): Shapes = Shapes(
        extraSmall = xs,
        small = sm,
        medium = control,
        large = surface,
        extraLarge = panel,
    )
}

/** sui-base shapes: chromatika's default, rounded across the scale. */
val ChromaSuiShapes: ChromaShapeTokens = ChromaShapeTokens(
    panel = RoundedCornerShape(22.dp),
    surface = RoundedCornerShape(18.dp),
    control = RoundedCornerShape(14.dp),
    sm = RoundedCornerShape(10.dp),
    xs = RoundedCornerShape(6.dp),
    pill = RoundedCornerShape(percent = 50),
)

/** solana-base shapes: zero radius across the board (the visual signal for pre-alpha base). */
val ChromaSolanaShapes: ChromaShapeTokens = ChromaShapeTokens(
    panel = RoundedCornerShape(0.dp),
    surface = RoundedCornerShape(0.dp),
    control = RoundedCornerShape(0.dp),
    sm = RoundedCornerShape(0.dp),
    xs = RoundedCornerShape(0.dp),
    pill = RoundedCornerShape(0.dp),
)
