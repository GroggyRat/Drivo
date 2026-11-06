package fj.kaitech.drivo.core.tracking

import fj.kaitech.drivo.core.geo.LngLat

/** One location fix from the phone (FusedLocationProvider on Android, Core Location on iOS). */
data class Fix(
    val timeMs: Long,
    val lon: Double,
    val lat: Double,
    /** Reported horizontal accuracy, metres (68% radius). */
    val accuracyM: Double,
    /** Speed over ground in m/s, if the device reported one. */
    val speedMps: Double?,
    val headingDeg: Double?,
) {
    val position get() = LngLat(lon, lat)

    /** The upload format: [epoch_ms, lon, lat, accuracy_m, speed_mps, heading_deg]. */
    fun toWire(): List<Number> = listOf(timeMs, lon, lat, accuracyM, speedMps ?: 0.0, headingDeg ?: 0.0)
}
