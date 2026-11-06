package fj.kaitech.drivo.ui.screens

import android.Manifest
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import fj.kaitech.drivo.MainViewModel
import fj.kaitech.drivo.tracking.TrackingState
import fj.kaitech.drivo.ui.components.Badge
import fj.kaitech.drivo.ui.components.Card
import fj.kaitech.drivo.ui.components.PrimaryButton
import fj.kaitech.drivo.ui.components.SecondaryButton
import fj.kaitech.drivo.ui.components.Tone
import fj.kaitech.drivo.ui.components.stopBadge
import fj.kaitech.drivo.ui.theme.Drivo

/** Today's run: summary, the next stop, and every stop. */
@Composable
fun RunScreen(vm: MainViewModel, nav: NavController) {
    val ui by vm.ui.collectAsState()
    val tracking by TrackingState.flow.collectAsState()
    val context = LocalContext.current
    val route = ui.active
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.ACCESS_FINE_LOCATION] == true && route != null) vm.startRoute(route)
    }
    val clockInPermissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.ACCESS_FINE_LOCATION] == true) vm.clockIn()
    }

    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Today's run", style = MaterialTheme.typography.headlineSmall)
            if (!ui.online) Badge("No signal: showing the run saved at shift start", Tone.Amber)
            ui.message?.let { Text(it, color = Drivo.Bad) }
        }
        ui.shift?.takeIf { it.clockInHere }?.let { shift ->
            item {
                Card {
                    val open = shift.shift
                    if (open != null) {
                        Text("On shift since ${timeOf(open.startedAt)}", style = MaterialTheme.typography.titleMedium)
                        Text("Your location is shared with your dispatcher until you clock out.", color = Drivo.Muted)
                        SecondaryButton("Clock out", { vm.clockOut() }, Modifier.fillMaxWidth(), enabled = !ui.clocking)
                    } else {
                        Text("Not on shift", style = MaterialTheme.typography.titleMedium)
                        Text("Clock in when you start work. Your location is shared until you clock out.", color = Drivo.Muted)
                        PrimaryButton("Clock in", {
                            clockInPermissions.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.POST_NOTIFICATIONS))
                        }, Modifier.fillMaxWidth(), enabled = !ui.clocking)
                    }
                }
            }
        }
        if (route == null) {
            item { Card { Text(if (ui.loading) "Loading your run" else "No route sent to you for today.", color = Drivo.Muted) } }
            return@LazyColumn
        }
        val stops = route.orderedStops
        val done = stops.count { it.status !in listOf("scheduled", "arrived") }
        item {
            Card {
                Text(route.name ?: "Route", style = MaterialTheme.typography.titleMedium)
                Text("$done of ${stops.size} stops done, ${stops.sumOf { it.order?.cartons ?: 0 }} cartons, ${"%.1f".format((route.plannedDistanceM ?: 0) / 1000.0)} km planned", color = Drivo.Muted)
                Badge(if (tracking.tracking) "Sharing location" else "Not sharing location", if (tracking.tracking) Tone.Green else Tone.Grey)
                if (route.status == "sent") {
                    PrimaryButton("Start route", {
                        permissions.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.POST_NOTIFICATIONS))
                    }, Modifier.fillMaxWidth())
                }
            }
        }
        route.nextStop?.let { next ->
            item {
                Card {
                    Text("Next stop", style = MaterialTheme.typography.labelSmall, color = Drivo.Muted)
                    Text("${next.sequence}. ${next.location.name}", style = MaterialTheme.typography.titleMedium)
                    next.order?.let { Text("${it.reference}, ${it.cartons} cartons", color = Drivo.Muted) }
                    next.order?.invoicePdfPath?.let { path -> SecondaryButton("Open invoice", { vm.openInvoice(path) }, Modifier.fillMaxWidth()) }
                    next.location.directions?.let { Text(it, color = Drivo.Muted) }
                    if (next.plannedEta != null) Text("Planned ${timeOf(next.plannedEta)}", color = Drivo.Muted)
                    val started = route.status == "in_progress"
                    PrimaryButton("Start navigation", { nav.navigate("navigate/${next.id}") }, Modifier.fillMaxWidth(), enabled = started)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val phone = next.order?.customer?.phone
                        SecondaryButton("Call", { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))) }, Modifier.weight(1f), enabled = phone != null)
                        SecondaryButton("Arrived", { nav.navigate("arrived/${next.id}") }, Modifier.weight(1f), enabled = started)
                    }
                }
            }
        }
        item { Text("All stops", style = MaterialTheme.typography.titleMedium) }
        items(stops, key = { it.id }) { s ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("${s.sequence}", style = MaterialTheme.typography.titleMedium, color = Drivo.Blue)
                Column(Modifier.weight(1f)) {
                    Text(s.location.name, style = MaterialTheme.typography.bodyLarge)
                    Text(listOfNotNull(s.order?.reference, s.plannedEta?.let { "Planned ${timeOf(it)}" }).joinToString(", "), color = Drivo.Muted, style = MaterialTheme.typography.bodySmall)
                }
                val (label, tone) = stopBadge(s.status)
                Badge(label, tone)
            }
        }
    }
}
