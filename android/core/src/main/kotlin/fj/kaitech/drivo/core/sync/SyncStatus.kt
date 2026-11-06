package fj.kaitech.drivo.core.sync

/** Shown on the Day ledger next to each delivery. */
enum class SyncStatus(val label: String) {
    SYNCED("Synced"),
    WAITING("Waiting to sync"),
}

/** Retry delays for uploads when there is no signal: 15 s, 30 s, 1 min, 2 min, then every 5 min. */
fun retryDelayMs(attempt: Int): Long = when (attempt) {
    0 -> 15_000
    1 -> 30_000
    2 -> 60_000
    3 -> 120_000
    else -> 300_000
}
