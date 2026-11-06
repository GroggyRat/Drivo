import Foundation

/// One upload. The id is made on the phone so a retried upload is not stored twice.
public struct Batch: Equatable, Sendable, Codable {
    public let id: String
    public let points: [Fix]
    public var recordedFrom: Int64 { points.first!.timeMs }
    public var recordedTo: Int64 { points.last!.timeMs }
}

/// Collects kept fixes and closes a batch every 45 s or at 2,000 points.
public final class PointBatcher {
    private let flushEveryMs: Int64
    private let maxPoints: Int
    private let newId: () -> String
    private var current: [Fix] = []

    public init(flushEveryMs: Int64 = 45_000, maxPoints: Int = 2_000, newId: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.flushEveryMs = flushEveryMs
        self.maxPoints = maxPoints
        self.newId = newId
    }

    public func add(_ fix: Fix) -> Batch? {
        current.append(fix)
        let age = fix.timeMs - current[0].timeMs
        return age >= flushEveryMs || current.count >= maxPoints ? flush() : nil
    }

    public func flush() -> Batch? {
        guard !current.isEmpty else { return nil }
        defer { current.removeAll() }
        return Batch(id: newId(), points: current)
    }
}
