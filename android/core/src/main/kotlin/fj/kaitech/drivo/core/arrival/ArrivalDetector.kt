package fj.kaitech.drivo.core.arrival

import fj.kaitech.drivo.core.geo.Geo
import fj.kaitech.drivo.core.geo.LngLat
import fj.kaitech.drivo.core.tracking.Fix

/**
 * Geofence around the next stop. Arrival needs two fixes in a row inside the
 * radius (default 50 m, from tenant settings), counting the fix's accuracy,
 * so one stray fix does not trigger "You are at <shop>". "Not here yet"
 * snoozes the prompt until the driver has left the area (radius + 50 m).
 */
class ArrivalDetector(private val target: LngLat, private val radiusM: Double = 50.0) {
    enum class Event { NONE, ARRIVED }

    private var insideCount = 0
    private var prompted = false
    private var snoozed = false

    fun onFix(fix: Fix): Event {
        val d = Geo.distance(fix.position, target)
        if (snoozed) {
            if (d > radiusM + 50) {
                snoozed = false
                prompted = false
            }
            return Event.NONE
        }
        val inside = d - fix.accuracyM.coerceAtMost(radiusM / 2) <= radiusM
        insideCount = if (inside) insideCount + 1 else 0
        if (insideCount >= 2 && !prompted) {
            prompted = true
            return Event.ARRIVED
        }
        if (!inside && d > radiusM + 50) prompted = false
        return Event.NONE
    }

    /** The driver tapped "Not here yet". */
    fun notHereYet() {
        snoozed = true
        insideCount = 0
    }
}
