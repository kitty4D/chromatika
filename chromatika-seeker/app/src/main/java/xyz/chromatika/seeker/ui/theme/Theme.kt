package xyz.chromatika.seeker.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

private val LightColors = lightColorScheme(
    primary = ChromaPrimaryLight,
    onPrimary = ChromaOnPrimaryLight,
    secondary = ChromaSecondaryLight,
    background = ChromaBackgroundLight,
    surface = ChromaSurfaceLight,
    error = ChromaErrorLight,
)

private val DarkColors = darkColorScheme(
    primary = ChromaPrimaryDark,
    onPrimary = ChromaOnPrimaryDark,
    secondary = ChromaSecondaryDark,
    background = ChromaBackgroundDark,
    surface = ChromaSurfaceDark,
    error = ChromaErrorDark,
)

@Composable
fun ChromatikaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val ctx = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(
        colorScheme = colorScheme,
        typography = ChromatikaTypography,
        content = content,
    )
}
