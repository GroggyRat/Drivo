package fj.kaitech.drivo.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class Membership(
    @SerialName("tenant_id") val tenantId: String,
    val role: String,
    @SerialName("full_name") val fullName: String,
    val tenant: MemberTenant? = null,
) {
    /** The road alerts add-on, turned on per company by KaiTech. */
    val roadAlerts get() = tenant?.roadAlertsEnabled == true
}

@Serializable
data class MemberTenant(@SerialName("road_alerts_enabled") val roadAlertsEnabled: Boolean = false)

/** A hazard, police checkpoint or speed camera reported by a driver of the same company. */
@Serializable
data class RoadAlert(
    val id: String,
    /** hazard, police or speed_camera */
    val kind: String,
    val lon: Double = 0.0,
    val lat: Double = 0.0,
    @SerialName("reported_at") val reportedAt: String? = null,
    val confirmations: Int = 0,
    val mine: Boolean = false,
    val voted: Boolean = false,
    val active: Boolean = true,
) {
    val label get() = when (kind) {
        "police" -> "Police checkpoint"
        "speed_camera" -> "Speed camera"
        else -> "Hazard"
    }
}

@Serializable
data class StopLocation(val id: String, val name: String, val lon: Double, val lat: Double, @SerialName("landmark_directions") val directions: String? = null)

@Serializable
data class LineItem(val sku: String? = null, val description: String, val quantity: Double, val unit: String? = null)

@Serializable
data class StopOrder(
    val id: String,
    val reference: String,
    @SerialName("customer_name") val customerName: String,
    val cartons: Int,
    @SerialName("line_items") val lineItems: List<LineItem> = emptyList(),
    val customer: StopCustomer? = null,
    @SerialName("invoice_pdf_path") val invoicePdfPath: String? = null,
)

/** The driver's shift, from my_shift, clock_in and clock_out. */
@Serializable
data class ShiftInfo(
    /** False when the company clocks in through KaiWorkforce. */
    @SerialName("clock_in_here") val clockInHere: Boolean,
    val tracking: Boolean,
    val shift: OpenShift? = null,
)

@Serializable
data class OpenShift(val id: String, val source: String, @SerialName("started_at") val startedAt: String)

@Serializable
data class StopCustomer(val phone: String? = null)

@Serializable
data class Stop(
    val id: String,
    val sequence: Int,
    val status: String,
    @SerialName("planned_eta") val plannedEta: String? = null,
    @SerialName("completed_at") val completedAt: String? = null,
    val location: StopLocation,
    val order: StopOrder? = null,
)

@Serializable
data class Depot(val name: String, val lon: Double, val lat: Double)

@Serializable
data class Route(
    val id: String,
    val name: String? = null,
    val status: String,
    @SerialName("route_date") val routeDate: String,
    @SerialName("vehicle_id") val vehicleId: String? = null,
    @SerialName("planned_distance_m") val plannedDistanceM: Int? = null,
    @SerialName("planned_duration_s") val plannedDurationS: Int? = null,
    val depot: Depot,
    @SerialName("route_stops") val stops: List<Stop>,
) {
    val orderedStops get() = stops.sortedBy { it.sequence }
    val nextStop get() = orderedStops.firstOrNull { it.status == "scheduled" || it.status == "arrived" }
}

@Serializable
data class TenantSettings(
    @SerialName("urban_speed_limit_kmh") val urbanLimit: Int,
    @SerialName("highway_speed_limit_kmh") val highwayLimit: Int,
    @SerialName("speed_alert_after_s") val alertAfterS: Int,
    @SerialName("speed_tolerance_kmh") val toleranceKmh: Int,
    @SerialName("arrival_radius_m") val arrivalRadiusM: Int,
)

@Serializable
data class SpeedZone(val name: String, @SerialName("limit_kmh") val limitKmh: Int? = null, @SerialName("area_geojson") val area: kotlinx.serialization.json.JsonObject)
