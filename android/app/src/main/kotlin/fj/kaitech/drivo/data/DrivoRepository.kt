package fj.kaitech.drivo.data

import android.content.Context
import fj.kaitech.drivo.sync.SyncWorker
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.providers.builtin.Email
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.storage.storage
import kotlin.time.Duration.Companion.minutes
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

/**
 * Everything the driver app reads and writes. Reads go to Supabase and fall
 * back to what was saved at shift start. Writes go into the offline queue
 * first and are sent by SyncWorker, so nothing is lost without signal.
 */
class DrivoRepository(private val context: Context, val supabase: SupabaseClient, val dao: DrivoDao) {
    private val json = Json { ignoreUnknownKeys = true }
    val fiji: ZoneId = ZoneId.of("Pacific/Fiji")

    val userId get() = supabase.auth.currentUserOrNull()?.id
    var membership: Membership? = null
        private set

    suspend fun signIn(email: String, password: String) {
        supabase.auth.signInWith(Email) {
            this.email = email.trim()
            this.password = password
        }
        loadMembership()
    }

    suspend fun signOut() {
        supabase.auth.signOut()
        membership = null
    }

    /** The driver's company. A driver in more than one company works in the first one listed. */
    suspend fun loadMembership(): Membership? {
        val id = userId ?: return null
        membership = supabase.from("memberships")
            .select(Columns.raw("tenant_id, role, full_name, tenant:tenants(road_alerts_enabled)")) {
                filter {
                    eq("user_id", id)
                    eq("role", "driver")
                    eq("active", true)
                }
            }
            .decodeList<Membership>()
            .firstOrNull()
        return membership
    }

    private val routeColumns = Columns.raw(
        "id, name, status, route_date, vehicle_id, planned_distance_m, planned_duration_s, depot:depots(name, lon, lat), " +
            "route_stops(id, sequence, status, planned_eta, completed_at, location:locations(id, name, lon, lat, landmark_directions), " +
            "order:orders(id, reference, customer_name, cartons, line_items, invoice_pdf_path, customer:customers(phone)))",
    )

    fun today(): String = LocalDate.now(fiji).toString()

    /** Today's routes: from Supabase when online (and saved for offline), else the saved copy. */
    suspend fun todaysRoutes(): Pair<List<Route>, Boolean> = try {
        val routes = supabase.from("routes").select(routeColumns) {
            filter { eq("route_date", today()) }
        }.decodeList<Route>()
        routes.forEach { dao.saveRoute(CachedRoute(it.id, it.routeDate, json.encodeToString(it), System.currentTimeMillis())) }
        dao.pruneRoutes(today())
        routes to true
    } catch (e: Exception) {
        dao.routesFor(today()).map { json.decodeFromString<Route>(it.json) } to false
    }

    suspend fun settings(): TenantSettings? = runCatching {
        supabase.from("tenant_settings").select().decodeSingle<TenantSettings>()
    }.getOrNull()

    suspend fun speedZones(): List<SpeedZone> = runCatching {
        supabase.from("speed_zones").select(Columns.list("name", "limit_kmh", "area_geojson")) { filter { eq("active", true) } }.decodeList<SpeedZone>()
    }.getOrDefault(emptyList())

    private fun tenantArg() = buildJsonObject { membership?.let { put("p_tenant_id", it.tenantId) } }

    /** Whether to offer Clock in, and the open shift. Null when offline. */
    suspend fun myShift(): ShiftInfo? = runCatching {
        supabase.postgrest.rpc("my_shift", tenantArg()).decodeAs<ShiftInfo>()
    }.getOrNull()

    suspend fun clockIn(): ShiftInfo = supabase.postgrest.rpc("clock_in", tenantArg()).decodeAs()

    suspend fun clockOut(): ShiftInfo = supabase.postgrest.rpc("clock_out", tenantArg()).decodeAs()

    // Road alerts (the add-on). All three need signal: an alert is only useful now.
    suspend fun roadAlertsNear(lon: Double, lat: Double): List<RoadAlert> =
        supabase.postgrest.rpc("road_alerts_near", buildJsonObject {
            put("p_lon", lon); put("p_lat", lat); put("p_radius_m", 30000)
            membership?.let { put("p_tenant_id", it.tenantId) }
        }).decodeList()

    suspend fun reportRoadAlert(kind: String, lon: Double, lat: Double): RoadAlert =
        supabase.postgrest.rpc("report_road_alert", buildJsonObject {
            put("p_kind", kind); put("p_lon", lon); put("p_lat", lat)
            membership?.let { put("p_tenant_id", it.tenantId) }
        }).decodeAs()

    suspend fun voteRoadAlert(id: String, stillThere: Boolean) {
        supabase.postgrest.rpc("vote_road_alert", buildJsonObject {
            put("p_alert_id", id); put("p_still_there", stillThere)
            membership?.let { put("p_tenant_id", it.tenantId) }
        })
    }

    /** A five-minute link to an order's invoice PDF. Needs signal. */
    suspend fun invoiceUrl(path: String): String =
        supabase.storage.from("invoices").createSignedUrl(path, 5.minutes)

    /** Starting a route: online only, because it also starts tracking without KaiWorkforce. */
    suspend fun startRoute(routeId: String): JsonObject =
        supabase.postgrest.rpc("start_route", buildJsonObject { put("p_route_id", routeId) }).decodeAs()

    suspend fun arrive(stopId: String, lon: Double?, lat: Double?) {
        dao.queueAction(PendingAction(UUID.randomUUID().toString(), "arrive_stop", buildJsonObject {
            put("p_stop_id", stopId)
            lon?.let { put("p_lon", it) }
            lat?.let { put("p_lat", it) }
        }.toString()))
        SyncWorker.enqueue(context)
    }

    /**
     * Complete a delivery. Photo and signature files are copied into the app's
     * storage and uploaded first; complete_stop runs after them with the same
     * proof id, so a retry never records the delivery twice.
     */
    suspend fun completeStop(route: Route, stop: Stop, proof: ProofInput) {
        val tenant = membership?.tenantId ?: error("Not signed in")
        val proofId = UUID.randomUUID().toString()
        val photoPath = proof.photo?.let { "$tenant/${stop.id}/photo.jpg" }
        val signaturePath = proof.signaturePng?.let { "$tenant/${stop.id}/signature.png" }
        proof.photo?.let { queueUpload(it, photoPath!!, "image/jpeg") }
        proof.signaturePng?.let { bytes ->
            val f = File(context.cacheDir, "proof/${stop.id}-signature.png").apply { parentFile?.mkdirs(); writeBytes(bytes) }
            queueUpload(f, signaturePath!!, "image/png")
        }
        val now = java.time.Instant.now().toString()
        dao.queueAction(PendingAction(proofId, "complete_stop", buildJsonObject {
            put("p_stop_id", stop.id)
            put("p_proof", buildJsonObject {
                put("id", proofId)
                put("outcome", proof.outcome)
                proof.receivedBy?.let { put("received_by", it) }
                proof.notes?.let { put("partial_notes", it) }
                photoPath?.let { put("photo_path", it) }
                signaturePath?.let { put("signature_path", it) }
                proof.lon?.let { put("lon", it) }
                proof.lat?.let { put("lat", it) }
                proof.accuracyM?.let { put("accuracy_m", it) }
                put("captured_at", now)
            })
        }.toString()))
        dao.saveLedger(LedgerEntry(stop.id, route.id, stop.location.name, stop.order?.reference, proof.outcome, proof.receivedBy, stop.order?.cartons ?: 0, System.currentTimeMillis(), synced = false))
        SyncWorker.enqueue(context)
    }

    /** Drop a pin for a new shop, fuel stop or hazard. Waits for an Admin to approve it. */
    suspend fun dropPin(pin: PinInput) {
        val tenant = membership?.tenantId ?: error("Not signed in")
        val id = UUID.randomUUID().toString()
        val photoPath = pin.photo?.let { "$tenant/pins/$id.jpg" }
        pin.photo?.let { queueUpload(it, photoPath!!, "image/jpeg", bucket = "location-photos") }
        dao.queueAction(PendingAction(id, "submit_location", buildJsonObject {
            put("p_tenant_id", tenant)
            put("p_name", pin.name)
            put("p_type", pin.type)
            put("p_lon", pin.lon)
            put("p_lat", pin.lat)
            pin.accuracyM?.let { put("p_accuracy_m", it) }
            pin.directions?.let { put("p_landmark_directions", it) }
            photoPath?.let { put("p_photo_path", it) }
        }.toString()))
        SyncWorker.enqueue(context)
    }

    private suspend fun queueUpload(file: File, path: String, contentType: String, bucket: String = "delivery-proofs") {
        dao.queueAction(PendingAction(UUID.randomUUID().toString(), "upload", buildJsonObject {
            put("bucket", bucket)
            put("path", path)
            put("content_type", contentType)
        }.toString(), filePath = file.absolutePath))
    }
}

data class ProofInput(
    /** delivered, partially_delivered or failed */
    val outcome: String,
    val receivedBy: String?,
    val notes: String?,
    val photo: File?,
    val signaturePng: ByteArray?,
    val lon: Double?,
    val lat: Double?,
    val accuracyM: Double?,
)

data class PinInput(
    val name: String,
    /** shop, fuel, depot or hazard */
    val type: String,
    val lon: Double,
    val lat: Double,
    val accuracyM: Double?,
    val directions: String?,
    val photo: File?,
)
