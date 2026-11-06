package fj.kaitech.drivo.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import fj.kaitech.drivo.ui.theme.Drivo

/** Black primary button, at least 48 dp tall. */
@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick, enabled = enabled, shape = RoundedCornerShape(8.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Drivo.Black, contentColor = Color.White),
        modifier = modifier.heightIn(min = 48.dp),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}

/** White secondary button with a 1 px grey border. */
@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    OutlinedButton(
        onClick = onClick, enabled = enabled, shape = RoundedCornerShape(8.dp), border = BorderStroke(1.dp, Drivo.Line),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Color.White, contentColor = Drivo.Ink),
        modifier = modifier.heightIn(min = 48.dp),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}

enum class Tone(val fg: Color, val bg: Color) {
    Green(Drivo.Ok, Drivo.OkBg), Red(Drivo.Bad, Drivo.BadBg), Amber(Drivo.Warn, Drivo.WarnBg), Grey(Drivo.Neutral, Drivo.NeutralBg)
}

@Composable
fun Badge(text: String, tone: Tone) {
    Text(
        text, color = tone.fg, style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.background(tone.bg, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

fun stopBadge(status: String): Pair<String, Tone> = when (status) {
    "delivered" -> "Delivered" to Tone.Green
    "partially_delivered" -> "Part delivered" to Tone.Amber
    "failed" -> "Not delivered" to Tone.Red
    "arrived" -> "Arrived" to Tone.Grey
    "skipped" -> "Skipped" to Tone.Grey
    else -> "Scheduled" to Tone.Grey
}

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(
        modifier.fillMaxWidth().background(Color.White, RoundedCornerShape(10.dp)).border(1.dp, Drivo.Line, RoundedCornerShape(10.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

/** Current speed beside the speed limit. Red once over the limit for the alert time. */
@Composable
fun SpeedReadout(speedKmh: Int, limitKmh: Int?, alert: Boolean, modifier: Modifier = Modifier) {
    val label = "Speed $speedKmh kilometres an hour" + (limitKmh?.let { ", limit $it" } ?: "")
    Row(modifier.semantics { contentDescription = label }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(
            Modifier.background(if (alert) Drivo.Bad else Color.White, RoundedCornerShape(10.dp)).border(1.dp, Drivo.Line, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("$speedKmh", style = MaterialTheme.typography.headlineSmall, color = if (alert) Color.White else Drivo.Ink)
            Text("km/h", style = MaterialTheme.typography.labelSmall, color = if (alert) Color.White else Drivo.Muted)
        }
        if (limitKmh != null) {
            Column(
                Modifier.background(Color.White, RoundedCornerShape(50)).border(4.dp, Drivo.Bad, RoundedCornerShape(50)).padding(12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) { Text("$limitKmh", style = MaterialTheme.typography.titleMedium, color = Drivo.Ink) }
        }
    }
}
