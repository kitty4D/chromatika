package xyz.chromatika.seeker.ui.theme

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlin.math.max
import kotlin.random.Random

/**
 * the chromatika visual surface. wraps content with the canonical 4-layer chrome:
 *
 *  1. solid ink fill from [LocalChromaPalette.current.ink]
 *  2. [AmbientBackground] - two radial gradients (sui: violet + teal, solana: mint + violet)
 *     sized to the actual window via [BoxWithConstraints], not hardcoded pixels
 *  3. [FilmGrainOverlay] - 256x256 tiled noise at 3.8% alpha (matches `wallet.css`)
 *  4. [ChromaRibbon] - 2dp horizontal gradient strip just below the system status bar.
 *     uses the 4-stop chromatika ribbon ("ika red, violet, sky, ika return") from
 *     [ChromaBrush.chromaRibbon].
 *
 * use by wrapping [SeekerNavHost] inside `ChromaSurface { ... }`. the Scaffold underneath must
 * use `containerColor = Color.Transparent` so the ambient + grain show through; otherwise
 * Scaffold's default material3 background covers everything.
 */
@Composable
fun ChromaSurface(content: @Composable () -> Unit) {
    val palette = LocalChromaPalette.current
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.ink),
    ) {
        AmbientBackground(modifier = Modifier.fillMaxSize())
        FilmGrainOverlay(modifier = Modifier.fillMaxSize())
        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.statusBars)
                .height(2.dp)
                .background(ChromaBrush.chromaRibbon),
        )
        content()
    }
}

/**
 * size-aware ambient gradients. the chromatika extension's css uses percentage-based radial
 * gradient centers (`radial-gradient(900px circle at 8% -8%, ...)`); we mirror that by
 * computing pixel offsets from the actual window dimensions. radius scales with the max
 * dimension so the gradient stays balanced on phone (~412dp wide) and tablet (~600dp+) alike.
 *
 * dual-chain branch: sui = violet (top-left) + teal (top-right), solana = mint (top-left) +
 * violet (top-right). matches the `--theme-sp-root-bg` token in `theme.css`.
 */
@Composable
private fun AmbientBackground(modifier: Modifier = Modifier) {
    val baseChain = LocalIkaBaseChain.current
    BoxWithConstraints(modifier = modifier) {
        val density = LocalDensity.current
        val w = with(density) { maxWidth.toPx() }
        val h = with(density) { maxHeight.toPx() }
        val maxDim = max(w, h)
        val gradients: List<Brush> = when (baseChain) {
            IkaBaseChain.Sui -> listOf(
                Brush.radialGradient(
                    colors = listOf(Color(0xFF7C5CFC).copy(alpha = 0.26f), Color.Transparent),
                    center = Offset(0.08f * w, -0.08f * h),
                    radius = maxDim * 0.85f,
                ),
                Brush.radialGradient(
                    colors = listOf(Color(0xFF14B8A6).copy(alpha = 0.16f), Color.Transparent),
                    center = Offset(0.96f * w, 0.04f * h),
                    radius = maxDim * 0.65f,
                ),
            )
            IkaBaseChain.Solana -> listOf(
                Brush.radialGradient(
                    colors = listOf(Color(0xFF14F195).copy(alpha = 0.14f), Color.Transparent),
                    center = Offset(0.06f * w, -0.06f * h),
                    radius = maxDim * 0.82f,
                ),
                Brush.radialGradient(
                    colors = listOf(Color(0xFF9945FF).copy(alpha = 0.10f), Color.Transparent),
                    center = Offset(w, 0f),
                    radius = maxDim * 0.65f,
                ),
            )
        }
        // each gradient gets its own fullsize Box so they composite additively.
        for (brush in gradients) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(brush),
            )
        }
    }
}

/**
 * tiled noise overlay. matches the chromatika extension's `wallet.css` `.ch-ext--popup
 * .wc-root::before` SVG-noise overlay (3.8% alpha, 256x256 tile).
 *
 * implementation: build a 256x256 [Bitmap] of random grayscale pixels once (cached via
 * [remember] keyed on a stable seed so the same noise renders every recompose), wrap as
 * an [ImageShader] in repeat-repeat mode, paint via [Canvas] with [opacity] alpha.
 *
 * cost: one 256KB bitmap per process. the GPU tiles it natively, so the per-frame cost is
 * essentially zero - it's a single textured rect.
 */
@Composable
private fun FilmGrainOverlay(
    modifier: Modifier = Modifier,
    opacity: Float = 0.038f,
) {
    val noiseBitmap = remember { buildNoiseBitmap(width = 256, height = 256, seed = 42L) }
    val shader = remember(noiseBitmap) { ImageShader(noiseBitmap, TileMode.Repeated, TileMode.Repeated) }
    val brush = remember(shader) { ShaderBrush(shader) }
    Canvas(modifier = modifier) {
        drawRect(brush = brush, alpha = opacity)
    }
}

private fun buildNoiseBitmap(width: Int, height: Int, seed: Long) =
    Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bmp ->
        val rng = Random(seed)
        val pixels = IntArray(width * height)
        for (i in 0 until width * height) {
            val gray = rng.nextInt(256)
            // ARGB-packed gray. fully opaque per pixel; the call site applies alpha via drawRect.
            pixels[i] = (0xFF shl 24) or (gray shl 16) or (gray shl 8) or gray
        }
        bmp.setPixels(pixels, 0, width, 0, 0, width, height)
    }.asImageBitmap()
