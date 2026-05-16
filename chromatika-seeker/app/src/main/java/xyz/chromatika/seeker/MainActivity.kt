package xyz.chromatika.seeker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import xyz.chromatika.seeker.identity.SeedVaultIdentityFactory
import xyz.chromatika.seeker.ui.SeekerRoot

class MainActivity : ComponentActivity() {

    /**
     * registered in onCreate per the seed vault SDK contract - activity-result launchers must
     * be registered before the activity is `STARTED`. exposed app-wide via a CompositionLocal
     * once the setup flow lands in phase 1.
     */
    lateinit var seedVaultFactory: SeedVaultIdentityFactory
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        seedVaultFactory = SeedVaultIdentityFactory.register(this)
        enableEdgeToEdge()
        setContent {
            SeekerRoot()
        }
    }
}
