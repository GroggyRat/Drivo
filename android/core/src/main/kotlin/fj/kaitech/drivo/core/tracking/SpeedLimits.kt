package fj.kaitech.drivo.core.tracking

import fj.kaitech.drivo.core.geo.LngLat

/**
 * The same rule as the server (app.speed_limit_at): inside an active town
 * zone, the zone's limit or the urban limit; where zones overlap, the
 * lowest; outside every zone, the highway limit. Polygons are GeoJSON rings
 * (lon, lat); the first ring of each polygon is the outline, the rest holes.
 */
class SpeedLimits(private val urbanKmh: Int, private val highwayKmh: Int, private val zones: List<Zone>) {
    data class Zone(val name: String, val limitKmh: Int?, val polygons: List<List<List<LngLat>>>)
    data class Limit(val kmh: Int, val zone: String?)

    fun at(p: LngLat): Limit {
        val inside = zones.filter { z -> z.polygons.any { contains(it, p) } }
        val best = inside.minByOrNull { it.limitKmh ?: urbanKmh } ?: return Limit(highwayKmh, null)
        return Limit(best.limitKmh ?: urbanKmh, best.name)
    }

    private fun contains(polygon: List<List<LngLat>>, p: LngLat): Boolean =
        polygon.isNotEmpty() && inRing(polygon[0], p) && polygon.drop(1).none { inRing(it, p) }

    /** Ray casting. Fiji zones never straddle the 180 degree meridian (they are towns). */
    private fun inRing(ring: List<LngLat>, p: LngLat): Boolean {
        var inside = false
        var j = ring.size - 1
        for (i in ring.indices) {
            val a = ring[i]
            val b = ring[j]
            if ((a.lat > p.lat) != (b.lat > p.lat) && p.lon < (b.lon - a.lon) * (p.lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside
            j = i
        }
        return inside
    }
}
