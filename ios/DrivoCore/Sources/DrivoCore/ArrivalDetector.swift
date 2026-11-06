import Foundation

/// Geofence around the next stop. Arrival needs two fixes in a row inside the
/// radius (default 50 m), so one stray fix does not open "You are at <shop>".
/// "Not here yet" snoozes until the driver has left (radius + 50 m).
public final class ArrivalDetector {
    public enum Event: Equatable, Sendable { case none, arrived }

    private let target: LngLat
    private let radiusM: Double
    private var insideCount = 0
    private var prompted = false
    private var snoozed = false

    public init(target: LngLat, radiusM: Double = 50) {
        self.target = target
        self.radiusM = radiusM
    }

    public func onFix(_ fix: Fix) -> Event {
        let d = Geo.distance(fix.position, target)
        if snoozed {
            if d > radiusM + 50 {
                snoozed = false
                prompted = false
            }
            return .none
        }
        let inside = d - min(fix.accuracyM, radiusM / 2) <= radiusM
        insideCount = inside ? insideCount + 1 : 0
        if insideCount >= 2 && !prompted {
            prompted = true
            return .arrived
        }
        if !inside && d > radiusM + 50 { prompted = false }
        return .none
    }

    public func notHereYet() {
        snoozed = true
        insideCount = 0
    }
}
