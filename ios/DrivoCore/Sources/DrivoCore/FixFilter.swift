import Foundation

/// Drops fixes that would make tracks and speeds wrong: reported accuracy
/// worse than 30 m, fixes not newer than the last kept one, and jumps
/// implying a speed no delivery truck reaches (55 m/s, about 200 km/h),
/// allowing for both fixes' accuracy.
public final class FixFilter {
    public enum Reason: Equatable, Sendable { case inaccurate, outOfOrder, impossibleJump }
    public enum Result: Equatable, Sendable { case kept(Fix), dropped(Reason) }

    private let maxAccuracyM: Double
    private let maxSpeedMps: Double
    private var last: Fix?

    public init(maxAccuracyM: Double = 30, maxSpeedMps: Double = 55) {
        self.maxAccuracyM = maxAccuracyM
        self.maxSpeedMps = maxSpeedMps
    }

    public func accept(_ fix: Fix) -> Result {
        if fix.accuracyM.isNaN || fix.accuracyM < 0 || fix.accuracyM > maxAccuracyM { return .dropped(.inaccurate) }
        if let prev = last {
            if fix.timeMs <= prev.timeMs { return .dropped(.outOfOrder) }
            let seconds = Double(fix.timeMs - prev.timeMs) / 1000
            let metres = max(0, Geo.distance(prev.position, fix.position) - prev.accuracyM - fix.accuracyM)
            if metres / seconds > maxSpeedMps { return .dropped(.impossibleJump) }
        }
        last = fix
        return .kept(fix)
    }

    public func reset() { last = nil }
}
