package xyz.chromatika.seeker.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import xyz.chromatika.seeker.ui.screens.PreAlphaBanner

/**
 * one composable per setup wizard state. [VaultSetupScreen] picks which to render. all
 * inputs use `String` for keystroke ergonomics; the viewmodel converts to `CharArray` on
 * submit and zeroes after use.
 */
@Composable
fun VaultSetupScreen(
    onCompleted: () -> Unit,
    viewModel: VaultSetupViewModel = viewModel(),
) {
    val state by viewModel.state.collectAsState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 24.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        when (val s = state) {
            SetupState.Welcome -> WelcomePane(
                onPick = viewModel::pickMethod,
            )
            is SetupState.Password -> PasswordPane(
                method = s.method,
                error = s.error,
                onBack = viewModel::goBack,
                onSubmit = viewModel::submitPassword,
            )
            is SetupState.Working -> WorkingPane(method = s.method)
            is SetupState.Failed -> FailedPane(
                message = s.message,
                onRetry = viewModel::goBack,
            )
            SetupState.Done -> {
                // bounce back to wherever the caller wants us next.
                DoneSentinel(onCompleted)
            }
        }
    }
}

@Composable
private fun WelcomePane(onPick: (SetupMethod) -> Unit) {
    Text("welcome to chromatika", style = MaterialTheme.typography.displaySmall)
    Text(
        "set up a new vault. all key material stays on this device or in your seed vault.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    PreAlphaBanner()
    MethodCard(
        title = "seed vault (recommended)",
        body = "binds to the seeker's hardware-backed solana key. same wallet across the chrome extension + this app via deterministic ika derivation. needs a real seeker device or the seed vault simulator on android 12+.",
        cta = "set up with seed vault",
        onClick = { onPick(SetupMethod.Seeker) },
    )
    MethodCard(
        title = "password only",
        body = "encrypted argon2id + AES-GCM vault on this device. fastest path for testing the build. you can add seed vault later via vault settings.",
        cta = "use a password",
        onClick = { onPick(SetupMethod.Password) },
    )
    MethodCard(
        title = "import mnemonic",
        body = "paste a 12 or 24-word phrase. coming in the next port pass.",
        cta = "import mnemonic",
        onClick = { onPick(SetupMethod.Mnemonic) },
    )
}

@Composable
private fun MethodCard(title: String, body: String, cta: String, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = onClick, modifier = Modifier.fillMaxWidth()) { Text(cta) }
        }
    }
}

@Composable
private fun PasswordPane(
    method: SetupMethod,
    error: String?,
    onBack: () -> Unit,
    onSubmit: (CharArray, CharArray) -> Unit,
) {
    var pw by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    TextButton(onClick = onBack) { Text("back") }
    Text("set a vault password", style = MaterialTheme.typography.headlineMedium)
    Text(
        when (method) {
            SetupMethod.Seeker -> "seed vault holds your signing key; this password unlocks the local encrypted state (dapp permissions, dwallet metadata, etc)."
            SetupMethod.Password -> "this password encrypts your local vault. only stored as an argon2id-derived key on this device."
            SetupMethod.Mnemonic -> "your mnemonic + this password protect the local vault."
        },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    OutlinedTextField(
        value = pw,
        onValueChange = { pw = it },
        label = { Text("password") },
        modifier = Modifier.fillMaxWidth(),
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        singleLine = true,
    )
    OutlinedTextField(
        value = confirm,
        onValueChange = { confirm = it },
        label = { Text("confirm password") },
        modifier = Modifier.fillMaxWidth(),
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        singleLine = true,
    )
    if (error != null) {
        Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
    Button(
        onClick = { onSubmit(pw.toCharArray(), confirm.toCharArray()) },
        enabled = pw.isNotEmpty() && confirm.isNotEmpty(),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("create vault")
    }
}

@Composable
private fun WorkingPane(method: SetupMethod) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        Text(
            "deriving argon2id key (~500ms) and writing encrypted vault…",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(4.dp))
        Text("method: ${method.name.lowercase()}", style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun FailedPane(message: String, onRetry: () -> Unit) {
    Text("setup failed", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.error)
    Text(message, style = MaterialTheme.typography.bodyMedium)
    OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text("try again") }
}

@Composable
private fun DoneSentinel(onCompleted: () -> Unit) {
    // tiny indirection so we can call back into nav exactly once when the state lands on Done.
    androidx.compose.runtime.LaunchedEffect(Unit) { onCompleted() }
    CircularProgressIndicator()
}

