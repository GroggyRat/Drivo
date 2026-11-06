package fj.kaitech.drivo.core.tracking

import fj.kaitech.drivo.core.geo.Geo

/**
 * Drops fixes that would make tracks and speeds wrong:
 *  - reported accuracy worse than [maxAccuracyM] (30 m),
 *  - fixes not newer than the last kept one,
 *  - jumps implying a speed no delivery truck reaches ([maxSpeedMps], 55 m/s, about 200 km/h),
 *    measured from the last kept fix and allowing for both fixes' accuracy.
 */
class FixFilter(
    private val maxAccuracyM: Double = 30.0,
    private val maxSpeedMps: Double = 55.0,
) {
    private var last: Fix? = null

    sealed interface Result {
        data class Kept(val fix: Fix) : Result
        data class Dropped(val reason: Reason) : Result
    }

    enum class Reason { INACCURATE, OUT_OF_ORDER, IMPOSSIBLE_JUMP }

    fun accept(fix: Fix): Result {
        if (fix.accuracyM > maxAccuracyM || fix.accuracyM.isNaN()) return Result.Dropped(Reason.INACCURATE)
        val prev = last
        if (prev != null) {
            if (fix.timeMs <= prev.timeMs) return Result.Dropped(Reason.OUT_OF_ORDER)
            val seconds = (fix.timeMs - prev.timeMs) / 1000.0
            val metres = (Geo.distance(prev.position, fix.position) - prev.accuracyM - fix.accuracyM).coerceAtLeast(0.0)
            if (metres / seconds > maxSpeedMps) return Result.Dropped(Reason.IMPOSSIBLE_JUMP)
        }
        last = fix
        return Result.Kept(fix)
    }

    fun reset() {
        last = null
    }
}
