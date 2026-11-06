package fj.kaitech.drivo.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import fj.kaitech.drivo.MainViewModel
import fj.kaitech.drivo.tracking.TrackingState
import fj.kaitech.drivo.ui.components.Card
import fj.kaitech.drivo.ui.components.PrimaryButton
import fj.kaitech.drivo.ui.components.SecondaryButton
import fj.kaitech.drivo.ui.theme.Drivo

@Composable
fun ArrivedScreen(vm: MainViewModel, nav: NavController, stopId: String) {
    val ui by vm.ui.collectAsState()
    val fix = TrackingState.flow.collectAsState().value.lastFix
    val stop = ui.active?.stops?.firstOrNull { it.id == stopId } ?: return
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("You are at ${stop.location.name}", style = MaterialTheme.typography.headlineSmall)
        stop.order?.let { Text("${it.reference}, ${it.customerName}, ${it.cartons} cartons", color = Drivo.Muted) }
        stop.location.directions?.let { Card { Text(it) } }
        stop.order?.invoicePdfPath?.let { path -> SecondaryButton("Open invoice", { vm.openInvoice(path) }, Modifier.fillMaxWidth()) }
        PrimaryButton("Check in and start delivery", {
            vm.arrive(stop, fix?.lon, fix?.lat)
            nav.navigate("proof/$stopId")
        }, Modifier.fillMaxWidth())
        SecondaryButton("Not here yet", { nav.popBackStack() }, Modifier.fillMaxWidth())
    }
}
