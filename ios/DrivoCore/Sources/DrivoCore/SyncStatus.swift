import Foundation

/// Shown on the Day ledger next to each delivery.
public enum SyncStatus: String, Sendable {
    case synced = "Synced"
    case waiting = "Waiting to sync"
}

/// Retry delays without signal: 15 s, 30 s, 1 min, 2 min, then every 5 min.
public func retryDelaySeconds(attempt: Int) -> Double {
    switch attempt {
    case 0: return 15
    case 1: return 30
    case 2: return 60
    case 3: return 120
    default: return 300
    }
}
