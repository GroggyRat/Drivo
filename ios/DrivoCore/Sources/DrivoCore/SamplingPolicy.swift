import Foundation

/// About every 4 seconds while moving, every 45 seconds once the vehicle has
/// been still for a minute (parked at a shop).
public final class SamplingPolicy {
    public let movingIntervalMs: Int64
    public let stationaryIntervalMs: Int64
    private let stillSpeedMps: Double
    private let stillForMs: Int64
    private var stillSince: Int64?
    public private(set) var intervalMs: Int64

    public init(movingIntervalMs: Int64 = 4_000, stationaryIntervalMs: Int64 = 45_000, stillSpeedMps: Double = 1, stillForMs: Int64 = 60_000) {
        self.movingIntervalMs = movingIntervalMs
        self.stationaryIntervalMs = stationaryIntervalMs
        self.stillSpeedMps = stillSpeedMps
        self.stillForMs = stillForMs
        self.intervalMs = movingIntervalMs
    }

    /// Returns true when the interval changed, so location settings should be updated.
    @discardableResult
    public func onFix(_ fix: Fix) -> Bool {
        let before = intervalMs
        if (fix.speedMps ?? 0) >= stillSpeedMps {
            stillSince = nil
            intervalMs = movingIntervalMs
        } else {
            let since = stillSince ?? fix.timeMs
            stillSince = since
            if fix.timeMs - since >= stillForMs { intervalMs = stationaryIntervalMs }
        }
        return before != intervalMs
    }

    /// Whether to keep this fix, given the current interval and the last kept fix time.
    public func isDue(_ fix: Fix, lastKeptMs: Int64?) -> Bool {
        guard let last = lastKeptMs else { return true }
        return fix.timeMs - last >= intervalMs - 500
    }
}
