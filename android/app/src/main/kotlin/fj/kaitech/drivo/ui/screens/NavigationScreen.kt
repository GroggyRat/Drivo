package fj.kaitech.drivo.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.stadiamaps.ferrostar.composeui.views.components.InstructionsView
import com.stadiamaps.ferrostar.core.DefaultNavigationViewModel
import com.stadiamaps.ferrostar.maplibreui.views.DynamicallyOrientingNavigationView
import fj.kaitech.drivo.BuildConfig
import fj.kaitech.drivo.MainViewModel
import fj.kaitech.drivo.core.arrival.ArrivalDetector
import fj.kaitech.drivo.core.geo.LngLat
import fj.kaitech.drivo.nav.Navigation
import fj.kaitech.drivo.tracking.TrackingState
import fj.kaitech.drivo.ui.components.SecondaryButton
import fj.kaitech.drivo.ui.components.SpeedReadout
import fj.kaitech.drivo.ui.theme.Drivo
import kotlinx.coroutines.launch
import uniffi.ferrostar.GeographicCoordinate
import uniffi.ferrostar.UserLocation
import uniffi.ferrostar.Waypoint
import uniffi.ferrostar.WaypointKind
import java.time.Instant

/**
 * In-app navigation to the next stop: Ferrostar's map with the route line,
 * turn banner ("In 400 m, turn right onto Ratu Mara Rd"), rerouting and
 * voice with a mute button; our speed readout beside the limit; and the
 * arrival geofence, which opens "You are at <shop>".
 */
@Composable
fun NavigationScreen(vm: MainViewModel, nav: NavController, stopId: String) {
    val context = LocalContext.current
    val ui by vm.ui.collectAsState()
    val tracking by TrackingState.flow.collectAsState()
    val route = ui.active ?: return
    val stop = route.stops.firstOrNull { it.id == stopId } ?: return
    val following = route.orderedStops.firstOrNull { it.sequence > stop.sequence && it.status == "scheduled" }
    val core = remember { Navigation.core(context) }
    var error by remember { mutableStateOf<String?>(null) }
    var muted by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val detector = remember(stopId) { ArrivalDetector(LngLat(stop.location.lon, stop.location.lat)) }
    val model = remember { DefaultNavigationViewModel(core) }

    LaunchedEffect(stopId) {
        val fix = tracking.lastFix ?: currentLocation(context)?.let { l ->
            fj.kaitech.drivo.core.tracking.Fix(l.time, l.longitude, l.latitude, l.accuracy.toDouble(), l.speed.toDouble(), l.bearing.toDouble())
        }
        if (fix == null) {
            error = "Waiting for your location. Step outside or check that location is on."
            return@LaunchedEffect
        }
        runCatching {
            val routes = core.getRoutes(
                UserLocation(GeographicCoordinate(fix.lat, fix.lon), fix.accuracyM, null, Instant.ofEpochMilli(fix.timeMs), null),
                listOfNotNull(
                    Waypoint(GeographicCoordinate(stop.location.lat, stop.location.lon), WaypointKind.BREAK),
                ),
            )
            core.startNavigation(routes.first())
        }.onFailure { error = "Could not get directions. The route line will show when there is signal." }
    }

    // Arrival geofence (default 50 m).
    LaunchedEffect(tracking.lastFix) {
        val fix = tracking.lastFix ?: return@LaunchedEffect
        if (detector.onFix(fix) == ArrivalDetector.Event.ARRIVED) nav.navigate("arrived/$stopId")
    }

    Box(Modifier.fillMaxSize()) {
        DynamicallyOrientingNavigationView(
            modifier = Modifier.fillMaxSize(),
            styleUrl = BuildConfig.MAP_STYLE_URL,
            viewModel = model,
            onTapExit = { scope.launch { core.stopNavigation() }; nav.popBackStack() },
        )
        Column(Modifier.align(Alignment.BottomStart).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RoadAlertsPanel(vm, Modifier.fillMaxWidth(0.62f))
            SpeedReadout(tracking.speedKmh, tracking.limitKmh, tracking.alert)
            following?.let {
                Text("Then: ${it.location.name}", color = Drivo.Muted,
                    modifier = Modifier.background(Color.White.copy(alpha = 0.85f), RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 4.dp))
            }
        }
        Row(Modifier.align(Alignment.BottomEnd).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton(if (muted) "Unmute voice" else "Mute voice", {
                muted = !muted
                Navigation.tts?.setMuted(muted)
            })
            SecondaryButton("Arrived", { nav.navigate("arrived/$stopId") })
        }
        error?.let {
            Text(it, color = Color.White, style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.align(Alignment.TopCenter).fillMaxWidth().background(Drivo.Navy).padding(12.dp))
        }
    }
}
