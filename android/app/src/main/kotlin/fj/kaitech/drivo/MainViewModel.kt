package fj.kaitech.drivo

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import fj.kaitech.drivo.data.PinInput
import fj.kaitech.drivo.data.ProofInput
import fj.kaitech.drivo.core.geo.Geo
import fj.kaitech.drivo.core.geo.LngLat
import fj.kaitech.drivo.data.RoadAlert
import fj.kaitech.drivo.data.Route
import fj.kaitech.drivo.data.ShiftInfo
import fj.kaitech.drivo.data.Stop
import fj.kaitech.drivo.tracking.TrackingService
import fj.kaitech.drivo.tracking.TrackingState
import android.content.Intent
import android.net.Uri
import io.github.jan.supabase.realtime.broadcastFlow
import io.github.jan.supabase.realtime.channel
import android.speech.tts.TextToSpeech
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = (app as DrivoApp).repository

    data class UiState(
        val signedIn: Boolean = false,
        val loading: Boolean = false,
        val name: String = "",
        val routes: List<Route> = emptyList(),
        val online: Boolean = true,
        val message: String? = null,
        val shift: ShiftInfo? = null,
        val clocking: Boolean = false,
        /** The company has the road alerts add-on. */
        val roadAlertsOn: Boolean = false,
        val roadAlerts: List<RoadAlert> = emptyList(),
        /** The driver's own report just sent, for Undo. */
        val reported: RoadAlert? = null,
        val roadBusy: Boolean = false,
    ) {
        val active get() = routes.firstOrNull { it.status == "in_progress" } ?: routes.firstOrNull { it.status == "sent" }
    }

    private val state = MutableStateFlow(UiState(signedIn = repo.userId != null))
    val ui: StateFlow<UiState> = state

    val ledger = repo.dao.ledgerSince(java.time.LocalDate.now(repo.fiji).atStartOfDay(repo.fiji).toInstant().toEpochMilli())
    val waitingBatches = repo.dao.batchCount()
    val waitingActions = repo.dao.actionCount()

    init {
        if (repo.userId != null) refresh()
    }

    fun signIn(email: String, password: String) = viewModelScope.launch {
        state.value = state.value.copy(loading = true, message = null)
        runCatching { repo.signIn(email, password) }
            .onSuccess {
                if (repo.membership == null) {
                    state.value = UiState(message = "This account is not a driver. Ask your dispatcher to add you as a driver.")
                    repo.signOut()
                } else {
                    state.value = state.value.copy(signedIn = true, loading = false)
                    refresh()
                }
            }
            .onFailure { state.value = state.value.copy(loading = false, message = "That email and password do not match. Check them and try again.") }
    }

    fun signOut() = viewModelScope.launch {
        TrackingService.stop(getApplication())
        repo.signOut()
        state.value = UiState()
    }

    /** Loads today's run (and saves it for no signal), and listens for KaiWorkforce clock-in and clock-out. */
    fun refresh() = viewModelScope.launch {
        state.value = state.value.copy(loading = true)
        val m = repo.membership ?: repo.loadMembership()
        val (routes, online) = repo.todaysRoutes()
        state.value = state.value.copy(loading = false, routes = routes, online = online, name = m?.fullName ?: "", roadAlertsOn = m?.roadAlerts == true)
        if (m != null) listenForShifts(m.tenantId)
        if (m?.roadAlerts == true) watchRoadAlerts()
        repo.myShift()?.let { applyShift(it) }
    }

    /** Tracking follows the shift the server holds: on while it is open, off once it ends. */
    private fun applyShift(shift: ShiftInfo) {
        state.value = state.value.copy(shift = shift)
        val running = TrackingState.flow.value.tracking
        if (shift.tracking && !running) TrackingService.start(getApplication(), state.value.active?.vehicleId)
        if (!shift.tracking && running) TrackingService.stop(getApplication())
    }

    /** Clock in and out in Drivo, for companies without KaiWorkforce. */
    fun clockIn() = clock { repo.clockIn() }
    fun clockOut() = clock { repo.clockOut() }

    private fun clock(call: suspend () -> ShiftInfo) = viewModelScope.launch {
        state.value = state.value.copy(clocking = true, message = null)
        runCatching { call() }
            .onSuccess { applyShift(it) }
            .onFailure { state.value = state.value.copy(message = "Could not reach Drivo. Check your signal and try again.") }
        state.value = state.value.copy(clocking = false)
    }

    /** Opens the invoice PDF in the phone's PDF viewer. */
    fun openInvoice(path: String) = viewModelScope.launch {
        runCatching { repo.invoiceUrl(path) }
            .onSuccess { url ->
                getApplication<Application>().startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            .onFailure { state.value = state.value.copy(message = "The invoice needs signal to open. Try again when you have signal.") }
    }

    private var listening = false
    private fun listenForShifts(tenantId: String) {
        if (listening) return
        listening = true
        viewModelScope.launch {
            val ch = repo.supabase.channel("tenant:$tenantId")
            val flow = ch.broadcastFlow<JsonObject>("shift")
            ch.subscribe()
            flow.collect { msg ->
                if (msg["driver_id"]?.jsonPrimitive?.content != repo.userId) return@collect
                if (msg["tracking"]?.jsonPrimitive?.booleanOrNull == true) TrackingService.start(getApplication(), state.value.active?.vehicleId)
                else TrackingService.stop(getApplication())
            }
        }
    }

    // ---- Road alerts: hazards, police checkpoints and speed cameras from the company's drivers. ----
    private var watchingRoad = false
    private val warned = mutableSetOf<String>()
    private var tts: TextToSpeech? = null

    /** Where the driver is: the tracking fix on shift. Off shift there is none, and nothing is loaded. */
    private fun here(): LngLat? = TrackingState.flow.value.lastFix?.position

    /** Reloads nearby alerts every 30 seconds, and warns once for each as the driver comes within 600 m. */
    private fun watchRoadAlerts() {
        if (watchingRoad) return
        watchingRoad = true
        tts = TextToSpeech(getApplication()) {}
        viewModelScope.launch {
            var tick = 0
            while (true) {
                if (!state.value.signedIn || !state.value.roadAlertsOn) break
                if (tick % 6 == 0) loadRoadAlerts()
                roadAlertAhead()?.let { (alert, metres) ->
                    if (warned.add(alert.id)) {
                        tts?.speak("${alert.label} reported, ${maxOf(50, metres / 50 * 50)} metres away.", TextToSpeech.QUEUE_ADD, null, alert.id)
                    }
                }
                tick++
                delay(5_000)
            }
            watchingRoad = false
        }
    }

    private suspend fun loadRoadAlerts() {
        val p = here() ?: return
        runCatching { repo.roadAlertsNear(p.lon, p.lat) }.onSuccess { state.value = state.value.copy(roadAlerts = it) }
    }

    /** The nearest alert within 600 m that someone else reported, with the distance in metres. */
    fun roadAlertAhead(): Pair<RoadAlert, Int>? {
        val p = here() ?: return null
        return state.value.roadAlerts.filter { !it.mine }
            .map { it to Geo.distance(p, LngLat(it.lon, it.lat)).toInt() }
            .filter { it.second <= 600 }
            .minByOrNull { it.second }
    }

    fun reportRoadAlert(kind: String, lon: Double, lat: Double) = viewModelScope.launch {
        state.value = state.value.copy(roadBusy = true, message = null)
        runCatching { repo.reportRoadAlert(kind, lon, lat) }
            .onSuccess { state.value = state.value.copy(reported = it) }
            .onFailure { state.value = state.value.copy(message = "Could not send the report. Check your signal and try again.") }
        loadRoadAlerts()
        state.value = state.value.copy(roadBusy = false)
    }

    fun voteRoadAlert(id: String, stillThere: Boolean) = viewModelScope.launch {
        state.value = state.value.copy(roadBusy = true)
        runCatching { repo.voteRoadAlert(id, stillThere) }
            .onFailure { state.value = state.value.copy(message = "Could not send your answer. Check your signal and try again.") }
        if (state.value.reported?.id == id) state.value = state.value.copy(reported = null)
        loadRoadAlerts()
        state.value = state.value.copy(roadBusy = false)
    }

    fun clearReported() {
        state.value = state.value.copy(reported = null)
    }

    override fun onCleared() {
        tts?.shutdown()
        super.onCleared()
    }

    fun startRoute(route: Route) = viewModelScope.launch {
        runCatching { repo.startRoute(route.id) }
            .onSuccess { r ->
                if (r["tracking"]?.jsonPrimitive?.booleanOrNull == true) TrackingService.start(getApplication(), route.vehicleId)
                refresh()
            }
            .onFailure { state.value = state.value.copy(message = "Could not start the route. Check your signal and try again.") }
    }

    fun arrive(stop: Stop, lon: Double?, lat: Double?) = viewModelScope.launch { repo.arrive(stop.id, lon, lat) }

    fun complete(route: Route, stop: Stop, proof: ProofInput) = viewModelScope.launch {
        repo.completeStop(route, stop, proof)
        // Show the result straight away; the server copy follows when synced.
        state.value = state.value.copy(routes = state.value.routes.map { r ->
            if (r.id != route.id) r else r.copy(stops = r.stops.map { if (it.id == stop.id) it.copy(status = proof.outcome) else it })
        })
        if (state.value.routes.find { it.id == route.id }?.nextStop == null) TrackingService.stop(getApplication())
    }

    fun dropPin(pin: PinInput) = viewModelScope.launch {
        repo.dropPin(pin)
        state.value = state.value.copy(message = "Pin saved. It will be sent for review.")
    }

    fun clearMessage() {
        state.value = state.value.copy(message = null)
    }
}
