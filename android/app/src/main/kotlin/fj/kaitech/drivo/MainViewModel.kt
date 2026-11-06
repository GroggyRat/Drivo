package fj.kaitech.drivo

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import fj.kaitech.drivo.data.PinInput
import fj.kaitech.drivo.data.ProofInput
import fj.kaitech.drivo.data.Route
import fj.kaitech.drivo.data.Stop
import fj.kaitech.drivo.tracking.TrackingService
import io.github.jan.supabase.realtime.broadcastFlow
import io.github.jan.supabase.realtime.channel
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
        state.value = state.value.copy(loading = false, routes = routes, online = online, name = m?.fullName ?: "")
        if (m != null) listenForShifts(m.tenantId)
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
