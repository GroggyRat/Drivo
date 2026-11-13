package fj.kaitech.drivo.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import fj.kaitech.drivo.MainViewModel
import fj.kaitech.drivo.tracking.TrackingState
import fj.kaitech.drivo.ui.components.Card
import fj.kaitech.drivo.ui.components.PrimaryButton
import fj.kaitech.drivo.ui.components.SecondaryButton
import fj.kaitech.drivo.ui.theme.Drivo
import kotlinx.coroutines.launch

/**
 * Road alerts, for companies with the add-on: the warning for an alert coming
 * up (with "Still there" and "Not there"), and "Report on the road". Shows
 * nothing when the company does not have the add-on.
 */
@Composable
fun RoadAlertsPanel(vm: MainViewModel, modifier: Modifier = Modifier) {
    val ui by vm.ui.collectAsState()
    // Collected so the distance updates as the driver moves.
    val tracking by TrackingState.flow.collectAsState()
    if (!ui.roadAlertsOn) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var choosing by remember { mutableStateOf(false) }
    val ahead = remember(ui.roadAlerts, tracking.lastFix) { vm.roadAlertAhead() }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ahead?.let { (alert, metres) ->
            Card {
                Text("${alert.label}, ${maxOf(10, metres / 10 * 10)} m away", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Reported at ${timeOf(alert.reportedAt)}" + if (alert.confirmations > 0) ", confirmed by ${alert.confirmations}" else "",
                    color = Drivo.Muted,
                )
                if (alert.voted) {
                    Text("Your answer is saved.", color = Drivo.Muted)
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton("Still there", { vm.voteRoadAlert(alert.id, true) }, Modifier.weight(1f), enabled = !ui.roadBusy)
                        SecondaryButton("Not there", { vm.voteRoadAlert(alert.id, false) }, Modifier.weight(1f), enabled = !ui.roadBusy)
                    }
                }
            }
        }
        val reported = ui.reported
        if (reported != null) {
            Card {
                Text("${reported.label} reported.", style = MaterialTheme.typography.titleMedium)
                Text("Your company's drivers are warned as they come near.", color = Drivo.Muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton("Undo", { vm.voteRoadAlert(reported.id, false) }, Modifier.weight(1f), enabled = !ui.roadBusy)
                    SecondaryButton("Done", { vm.clearReported() }, Modifier.weight(1f))
                }
            }
        } else {
            SecondaryButton("Report on the road", { choosing = true }, Modifier.fillMaxWidth(), enabled = !ui.roadBusy)
        }
    }

    if (choosing) {
        val report: (String) -> Unit = { kind ->
            choosing = false
            scope.launch {
                // The tracking fix on shift; otherwise one fresh fix, if location is allowed.
                val fix = tracking.lastFix
                val here = fix?.let { it.lon to it.lat }
                    ?: runCatching { currentLocation(context) }.getOrNull()?.let { it.longitude to it.latitude }
                if (here != null) vm.reportRoadAlert(kind, here.first, here.second)
            }
        }
        AlertDialog(
            onDismissRequest = { choosing = false },
            title = { Text("What is on the road here?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("It is pinned where you are now.", color = Drivo.Muted)
                    PrimaryButton("Hazard", { report("hazard") }, Modifier.fillMaxWidth())
                    PrimaryButton("Police checkpoint", { report("police") }, Modifier.fillMaxWidth())
                    PrimaryButton("Speed camera", { report("speed_camera") }, Modifier.fillMaxWidth())
                }
            },
            confirmButton = {},
            dismissButton = { SecondaryButton("Cancel", { choosing = false }) },
        )
    }
}
