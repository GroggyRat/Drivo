package fj.kaitech.drivo.core.tracking

import java.util.UUID

/** One upload: a phone-made id so a retried upload is not stored twice. */
data class Batch(val id: String, val points: List<Fix>) {
    val recordedFrom get() = points.first().timeMs
    val recordedTo get() = points.last().timeMs
}

/**
 * Collects kept fixes and closes a batch every [flushEveryMs] (45 s) or at
 * [maxPoints]. Closed batches go to the offline queue (Room on Android) and
 * are uploaded when there is signal.
 */
class PointBatcher(
    private val flushEveryMs: Long = 45_000,
    private val maxPoints: Int = 2_000,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private val current = mutableListOf<Fix>()

    /** Adds a fix; returns a closed batch when one is due. */
    fun add(fix: Fix): Batch? {
        current += fix
        val age = fix.timeMs - current.first().timeMs
        return if (age >= flushEveryMs || current.size >= maxPoints) flush() else null
    }

    /** Closes whatever is collected (end of shift, app going to background). */
    fun flush(): Batch? {
        if (current.isEmpty()) return null
        val batch = Batch(newId(), current.toList())
        current.clear()
        return batch
    }
}
