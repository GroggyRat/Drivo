package fj.kaitech.drivo.tracking

import fj.kaitech.drivo.core.tracking.Fix
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** What the screens show while tracking: position, speed against the limit, and the shift. */
object TrackingState {
    data class Snapshot(
        val tracking: Boolean = false,
        val lastFix: Fix? = null,
        val speedKmh: Int = 0,
        val limitKmh: Int? = null,
        val overLimit: Boolean = false,
        val alert: Boolean = false,
        val waitingBatches: Int = 0,
    )

    private val state = MutableStateFlow(Snapshot())
    val flow: StateFlow<Snapshot> = state

    fun update(f: (Snapshot) -> Snapshot) {
        state.value = f(state.value)
    }
}
