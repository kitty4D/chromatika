package xyz.chromatika.seeker.ui

import androidx.compose.runtime.Composable
import xyz.chromatika.seeker.ui.nav.SeekerNavHost
import xyz.chromatika.seeker.ui.theme.ChromatikaTheme

/**
 * single entry composable. mounts the [ChromatikaTheme] + the bottom-nav shell. activity-level
 * concerns (seed vault factory registration, deep link handling) live in [MainActivity].
 */
@Composable
fun SeekerRoot() {
    ChromatikaTheme {
        SeekerNavHost()
    }
}
