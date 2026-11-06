package fj.kaitech.drivo.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import fj.kaitech.drivo.MainViewModel
import fj.kaitech.drivo.core.sync.SyncStatus
import fj.kaitech.drivo.data.PinInput
import fj.kaitech.drivo.tracking.TrackingState
import fj.kaitech.drivo.ui.components.Badge
import fj.kaitech.drivo.ui.components.Card
import fj.kaitech.drivo.ui.components.PrimaryButton
import fj.kaitech.drivo.ui.components.SecondaryButton
import fj.kaitech.drivo.ui.components.Tone
import fj.kaitech.drivo.ui.components.stopBadge
import fj.kaitech.drivo.ui.theme.Drivo
import kotlinx.coroutines.launch
import org.maplibre.android.annotations.MarkerOptions
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import java.io.File
import java.util.UUID

/** The run on a map: stops numbered, done ones marked, the next one first. */
@Composable
fun MapScreen(vm: MainViewModel) {
    val ui by vm.ui.collectAsState()
    val route = ui.active
    val centre = route?.nextStop?.location?.let { LatLng(it.lat, it.lon) } ?: route?.depot?.let { LatLng(it.lat, it.lon) } ?: LatLng(-18.1416, 178.4419)
    DrivoMap(Modifier.fillMaxSize(), centre, 12.5) { map ->
        route?.orderedStops?.forEach { s ->
            map.addMarker(MarkerOptions().position(LatLng(s.location.lat, s.location.lon)).title("${s.sequence}. ${s.location.name}").snippet(stopBadge(s.status).first))
        }
    }
}

/** Drop a pin: move the map under the centre pin, then describe the place. */
@Composable
fun DropPinScreen(vm: MainViewModel) {
    val context = LocalContext.current
    val ui by vm.ui.collectAsState()
    val tracking by TrackingState.flow.collectAsState()
    val scope = rememberCoroutineScope()
    var map by remember { mutableStateOf<MapLibreMap?>(null) }
    var name by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("shop") }
    var directions by remember { mutableStateOf("") }
    var photo by remember { mutableStateOf<File?>(null) }
    val photoFile = remember { File(context.cacheDir, "proof/pin-${UUID.randomUUID()}.jpg").apply { parentFile?.mkdirs() } }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) photo = photoFile }
    val start = tracking.lastFix?.let { LatLng(it.lat, it.lon) } ?: LatLng(-18.1416, 178.4419)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Drop a pin", style = MaterialTheme.typography.headlineSmall)
        Text("Move the map so the pin sits on the shop's door.", color = Drivo.Muted)
        Box(Modifier.fillMaxWidth().height(280.dp)) {
            DrivoMap(Modifier.fillMaxSize(), start, 17.0) { map = it }
            Icon(painterResource(android.R.drawable.ic_menu_mylocation), contentDescription = "Pin position", tint = Drivo.Bad, modifier = Modifier.align(Alignment.Center))
        }
        OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Text("Type", style = MaterialTheme.typography.labelLarge)
        listOf("shop" to "Shop", "fuel" to "Fuel stop", "depot" to "Depot", "hazard" to "Hazard").forEach { (value, label) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = type == value, onClick = { type = value })
                Text(label)
            }
        }
        OutlinedTextField(directions, { directions = it }, label = { Text("Directions and landmarks") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        SecondaryButton(if (photo != null) "Photo taken. Take again" else "Take photo", {
            takePhoto.launch(FileProvider.getUriForFile(context, "fj.kaitech.drivo.files", photoFile))
        })
        PrimaryButton("Submit for review", {
            val target = map?.cameraPosition?.target ?: start
            scope.launch {
                val fix = currentLocation(context)
                vm.dropPin(PinInput(name.trim(), type, target.longitude, target.latitude, fix?.accuracy?.toDouble(), directions.trim().ifBlank { null }, photo))
                name = ""; directions = ""; photo = null
            }
        }, Modifier.fillMaxWidth(), enabled = name.isNotBlank())
        ui.message?.let { Text(it, color = Drivo.Ok) }
    }
}

/** Day ledger: totals and every delivery, with whether it has reached the office. */
@Composable
fun LedgerScreen(vm: MainViewModel) {
    val entries by vm.ledger.collectAsState(initial = emptyList())
    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Text("Day ledger", style = MaterialTheme.typography.headlineSmall)
            Card {
                Text("${entries.count { it.outcome == "delivered" }} delivered, ${entries.count { it.outcome == "partially_delivered" }} part delivered, ${entries.count { it.outcome == "failed" }} not delivered")
                Text("${entries.filter { it.outcome != "failed" }.sumOf { it.cartons }} cartons delivered", color = Drivo.Muted)
            }
        }
        items(entries, key = { it.stopId }) { e ->
            Card {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(e.shopName, style = MaterialTheme.typography.bodyLarge)
                        Text(listOfNotNull(timeOf(e.completedAt), e.reference, e.receivedBy?.let { "received by $it" }).joinToString(", "), color = Drivo.Muted, style = MaterialTheme.typography.bodySmall)
                    }
                    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val (label, tone) = stopBadge(e.outcome)
                        Badge(label, tone)
                        val sync = if (e.synced) SyncStatus.SYNCED else SyncStatus.WAITING
                        Badge(sync.label, if (e.synced) Tone.Green else Tone.Amber)
                    }
                }
            }
        }
    }
}

@Composable
fun AccountScreen(vm: MainViewModel) {
    val ui by vm.ui.collectAsState()
    val tracking by TrackingState.flow.collectAsState()
    val batches by vm.waitingBatches.collectAsState(initial = 0)
    val actions by vm.waitingActions.collectAsState(initial = 0)
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Account", style = MaterialTheme.typography.headlineSmall)
        Card {
            Text(ui.name, style = MaterialTheme.typography.titleMedium)
            Badge(if (tracking.tracking) "Sharing location while on shift" else "Not sharing location", if (tracking.tracking) Tone.Green else Tone.Grey)
        }
        Card {
            Text("Waiting to sync", style = MaterialTheme.typography.titleMedium)
            Text(if (batches + actions == 0) "Everything is sent." else "$actions deliveries or pins and $batches location uploads will send when there is signal.", color = Drivo.Muted)
            SecondaryButton("Refresh today's run", { vm.refresh() })
        }
        SecondaryButton("Sign out", { vm.signOut() }, Modifier.fillMaxWidth(), enabled = batches + actions == 0 || !tracking.tracking)
        if (batches + actions > 0) Text("Sign out after everything has synced, so nothing is lost.", color = Drivo.Muted)
    }
}
