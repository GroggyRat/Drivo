package fj.kaitech.drivo.core.tracking

/**
 * Tells the driver when they are over the limit. The phone shows the
 * driver's speed next to the limit at all times; this turns the readout red
 * once they have been over the limit (plus tolerance) for [afterMs], the same
 * rule the server uses to record a speed event.
 */
class SpeedMonitor(private val afterMs: Long = 10_000, private val toleranceKmh: Int = 0) {
    private var overSince: Long? = null

    data class State(val speedKmh: Int, val limitKmh: Int?, val over: Boolean, val alert: Boolean)

    fun onFix(fix: Fix, limitKmh: Int?): State {
        val kmh = ((fix.speedMps ?: 0.0) * 3.6).toInt()
        val over = limitKmh != null && kmh > limitKmh + toleranceKmh
        if (over) {
            if (overSince == null) overSince = fix.timeMs
        } else {
            overSince = null
        }
        val alert = over && fix.timeMs - (overSince ?: fix.timeMs) >= afterMs
        return State(kmh, limitKmh, over, alert)
    }
}
