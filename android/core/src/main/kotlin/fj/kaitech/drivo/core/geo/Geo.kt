package fj.kaitech.drivo.core.geo

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** A position. Longitude -180..180; Fiji crosses the 180 degree meridian. */
data class LngLat(val lon: Double, val lat: Double)

object Geo {
    private const val R = 6_371_008.8
    private fun rad(d: Double) = d * Math.PI / 180

    /** Great-circle distance in metres. Correct across the 180 degree meridian. */
    fun distance(a: LngLat, b: LngLat): Double {
        val dLat = rad(b.lat - a.lat)
        val dLon = rad(b.lon - a.lon)
        val h = sin(dLat / 2).let { it * it } + cos(rad(a.lat)) * cos(rad(b.lat)) * sin(dLon / 2).let { it * it }
        return 2 * R * asin(min(1.0, sqrt(h)))
    }

    /** Initial bearing from a to b, 0..360 degrees. */
    fun bearing(a: LngLat, b: LngLat): Double {
        val y = sin(rad(b.lon - a.lon)) * cos(rad(b.lat))
        val x = cos(rad(a.lat)) * sin(rad(b.lat)) - sin(rad(a.lat)) * cos(rad(b.lat)) * cos(rad(b.lon - a.lon))
        return (Math.toDegrees(atan2(y, x)) + 360) % 360
    }
}
