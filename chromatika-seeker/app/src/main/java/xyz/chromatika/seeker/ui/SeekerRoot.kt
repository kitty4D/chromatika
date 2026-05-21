package xyz.chromatika.seeker.ui

import androidx.compose.runtime.Composable
import xyz.chromatika.seeker.ui.nav.SeekerNavHost
import xyz.chromatika.seeker.ui.theme.ChromaSurface
import xyz.chromatika.seeker.ui.theme.ChromatikaTheme

/**
 * single entry composable. mounts the [ChromatikaTheme], wraps everything in [ChromaSurface]
 * (ambient gradients + film grain + the chromatika ribbon strip), then the bottom-nav shell.
 * activity-level concerns (seed vault factory registration, deep link handling) live in
 * [MainActivity].
 */
@Composable
fun SeekerRoot() {
    ChromatikaTheme {
        ChromaSurface {
            SeekerNavHost()
        }
    }
}
