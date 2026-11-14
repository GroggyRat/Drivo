package fj.kaitech.drivo.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import fj.kaitech.drivo.ui.components.Card
import fj.kaitech.drivo.ui.components.PrimaryButton
import fj.kaitech.drivo.ui.components.SecondaryButton
import fj.kaitech.drivo.ui.theme.Drivo

/** Shown when the app last closed by itself: the report, with Send, Copy and Continue. */
@Composable
fun CrashScreen(report: String, onContinue: () -> Unit) {
    val context = LocalContext.current
    Column(
        Modifier.fillMaxSize().background(Drivo.Page).systemBarsPadding().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Drivo closed by itself last time", style = MaterialTheme.typography.headlineSmall)
        Text("Send this report to KaiTech so it can be fixed. It holds the error and your phone model, nothing about your deliveries.", color = Drivo.Muted)
        PrimaryButton("Send report", {
            context.startActivity(Intent.createChooser(
                Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, "Drivo report").putExtra(Intent.EXTRA_TEXT, report),
                "Send report",
            ))
        }, Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("Copy report", {
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Drivo report", report))
            }, Modifier.weight(1f))
            SecondaryButton("Continue", onContinue, Modifier.weight(1f))
        }
        Card(Modifier.weight(1f)) {
            SelectionContainer {
                Text(report, style = MaterialTheme.typography.bodySmall, modifier = Modifier.verticalScroll(rememberScrollState()))
            }
        }
    }
}
