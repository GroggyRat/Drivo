package fj.kaitech.drivo.core.tracking

/**
 * Adaptive sampling to save battery without losing the road:
 * about every 4 seconds while moving, every 45 seconds once the vehicle has
 * been still for a minute (parked at a shop). Moving again switches back on
 * the next fix.
 */
class SamplingPolicy(
    val movingIntervalMs: Long = 4_000,
    val stationaryIntervalMs: Long = 45_000,
    private val stillSpeedMps: Double = 1.0,
    private val stillForMs: Long = 60_000,
) {
    private var stillSince: Long? = null
    var intervalMs: Long = movingIntervalMs
        private set

    /** Returns true when the requested interval changed, so the location request should be updated. */
    fun onFix(fix: Fix): Boolean {
        val speed = fix.speedMps ?: 0.0
        val before = intervalMs
        if (speed >= stillSpeedMps) {
            stillSince = null
            intervalMs = movingIntervalMs
        } else {
            val since = stillSince ?: fix.timeMs.also { stillSince = it }
            if (fix.timeMs - since >= stillForMs) intervalMs = stationaryIntervalMs
        }
        return before != intervalMs
    }
}
