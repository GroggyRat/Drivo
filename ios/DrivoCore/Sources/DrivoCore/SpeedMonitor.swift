import Foundation

/// The driver's speed beside the limit; the readout turns red once they have
/// been over the limit (plus tolerance) for the alert time, the same rule the
/// server uses to record a speed event.
public final class SpeedMonitor {
    public struct State: Equatable, Sendable {
        public let speedKmh: Int
        public let limitKmh: Int?
        public let over: Bool
        public let alert: Bool
    }

    private let afterMs: Int64
    private let toleranceKmh: Int
    private var overSince: Int64?

    public init(afterMs: Int64 = 10_000, toleranceKmh: Int = 0) {
        self.afterMs = afterMs
        self.toleranceKmh = toleranceKmh
    }

    public func onFix(_ fix: Fix, limitKmh: Int?) -> State {
        let kmh = Int((fix.speedMps ?? 0) * 3.6)
        let over = limitKmh.map { kmh > $0 + toleranceKmh } ?? false
        if over { overSince = overSince ?? fix.timeMs } else { overSince = nil }
        let alert = over && fix.timeMs - (overSince ?? fix.timeMs) >= afterMs
        return State(speedKmh: kmh, limitKmh: limitKmh, over: over, alert: alert)
    }
}
