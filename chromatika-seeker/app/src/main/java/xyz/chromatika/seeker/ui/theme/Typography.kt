@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package xyz.chromatika.seeker.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import xyz.chromatika.seeker.R

/**
 * brand font families lifted from `theme.css` `--theme-font-{body,display,mono}`.
 * shipped as three variable TTFs under [`app/src/main/res/font/`](../../../../../../res/font/):
 *
 *  - `Figtree[wght].ttf` -> body
 *  - `BricolageGrotesque[opsz,wdth,wght].ttf` -> display (uses `opsz` axis for big sizes)
 *  - `JetBrainsMono[wght].ttf` -> monospace (addresses, digests, amounts)
 *
 * variable-axis support lands via [FontVariation.Settings] - android 12+ (our minSdk 31)
 * routes the variation to the freetype renderer natively.
 */
private fun figtree(weight: FontWeight) = Font(
    resId = R.font.figtree,
    weight = weight,
    style = FontStyle.Normal,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

private fun bricolage(weight: FontWeight, opticalSize: Float? = null) = Font(
    resId = R.font.bricolage_grotesque,
    weight = weight,
    style = FontStyle.Normal,
    variationSettings = FontVariation.Settings(
        *listOfNotNull(
            FontVariation.weight(weight.weight),
            opticalSize?.let { FontVariation.opticalSizing(it.sp) },
        ).toTypedArray(),
    ),
)

private fun jetbrainsMono(weight: FontWeight) = Font(
    resId = R.font.jetbrains_mono,
    weight = weight,
    style = FontStyle.Normal,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

val ChromaBodyFamily: FontFamily = FontFamily(
    figtree(FontWeight.Normal),
    figtree(FontWeight.Medium),
    figtree(FontWeight.SemiBold),
    figtree(FontWeight.Bold),
)

val ChromaDisplayFamily: FontFamily = FontFamily(
    bricolage(FontWeight.Normal, opticalSize = 14f),
    bricolage(FontWeight.Medium, opticalSize = 20f),
    bricolage(FontWeight.SemiBold, opticalSize = 28f),
    bricolage(FontWeight.Bold, opticalSize = 36f),
)

val ChromaMonoFamily: FontFamily = FontFamily(
    jetbrainsMono(FontWeight.Normal),
    jetbrainsMono(FontWeight.Medium),
    jetbrainsMono(FontWeight.Bold),
)

/**
 * 7-step type scale from `theme.css`. pinned at the same rem values translated to sp:
 *
 *  | rem      | sp   | role                                           |
 *  | -------- | ---- | ---------------------------------------------- |
 *  | 0.6875rem | 11sp | labels, fine print, banner secondary text     |
 *  | 0.8125rem | 13sp | secondary body, list rows                     |
 *  | 0.95rem   | 15sp | primary body                                  |
 *  | 1.18rem   | 19sp | subtitles / section headers                   |
 *  | 1.5rem    | 24sp | page titles                                   |
 *  | 2.25rem   | 36sp | hero                                          |
 *  | 3rem      | 48sp | onboarding wordmark                           |
 *
 * the m3 [Typography] slots are mapped so that:
 *  - `display{Large,Medium,Small}` use the **display** family (Bricolage Grotesque)
 *  - `headline{Large,Medium,Small}` use the **display** family
 *  - `title{Large,Medium,Small}` use the **body** family (Figtree) at heavier weights
 *  - `body{Large,Medium,Small}` use the **body** family
 *  - `label{Large,Medium,Small}` use the **body** family at smaller sizes
 *
 * monospace lives **outside** the m3 typography slots - addresses / digests use the
 * [ChromaMonoFamily] directly with a `TextStyle.copy(fontFamily = ChromaMonoFamily)`
 * per [AddressRow]. m3 has no canonical "code" slot.
 */
val ChromatikaTypography: Typography = Typography(
    displayLarge = TextStyle(fontFamily = ChromaDisplayFamily, fontWeight = FontWeight.Bold, fontSize = 48.sp, lineHeight = 56.sp),
    displayMedium = TextStyle(fontFamily = ChromaDisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 36.sp, lineHeight = 44.sp),
    displaySmall = TextStyle(fontFamily = ChromaDisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 38.sp),
    headlineLarge = TextStyle(fontFamily = ChromaDisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 28.sp, lineHeight = 36.sp),
    headlineMedium = TextStyle(fontFamily = ChromaDisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp),
    headlineSmall = TextStyle(fontFamily = ChromaDisplayFamily, fontWeight = FontWeight.Medium, fontSize = 19.sp, lineHeight = 26.sp),
    titleLarge = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.Medium, fontSize = 15.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 18.sp),
    bodyLarge = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp),
    bodySmall = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.Normal, fontSize = 11.sp, lineHeight = 15.sp),
    labelLarge = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 18.sp),
    labelMedium = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 15.sp),
    labelSmall = TextStyle(fontFamily = ChromaBodyFamily, fontWeight = FontWeight.Medium, fontSize = 10.sp, lineHeight = 14.sp),
)
