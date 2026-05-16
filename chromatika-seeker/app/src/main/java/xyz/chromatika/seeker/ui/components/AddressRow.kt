package xyz.chromatika.seeker.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * copyable monospace address row. mirrors the extension's `ExplorerValueRow` semantics
 * (read-only display + copy-to-clipboard) without the explorer-link wiring; that lands when
 * the chain explorer preferences port arrives.
 *
 *  - truncates long values to a head + tail with ellipsis in the middle.
 *  - tap the copy icon to drop the full value on the clipboard.
 *  - the row is non-interactive otherwise, so users can long-press without misfiring nav.
 */
@Composable
fun AddressRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        androidx.compose.foundation.layout.Column(
            modifier = Modifier.weight(1f),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = truncate(value),
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurface,
                overflow = TextOverflow.Ellipsis,
                maxLines = 1,
            )
        }
        IconButton(onClick = {
            copyToClipboard(context, label, value)
            copied = true
        }) {
            Icon(
                imageVector = Icons.Outlined.ContentCopy,
                contentDescription = if (copied) "copied" else "copy $label",
                tint = if (copied) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** head 6 chars … tail 6 chars. matches the extension's address truncation policy. */
private fun truncate(value: String): String {
    val head = 6
    val tail = 6
    return if (value.length <= head + tail + 1) value
    else "${value.take(head)}…${value.takeLast(tail)}"
}

private fun copyToClipboard(context: Context, label: String, value: String) {
    val clip = ClipData.newPlainText(label, value)
    val mgr = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    mgr.setPrimaryClip(clip)
}
