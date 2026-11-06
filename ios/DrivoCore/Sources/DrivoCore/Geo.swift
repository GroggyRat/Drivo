import Foundation

/// A position. Longitude -180...180; Fiji crosses the 180 degree meridian.
public struct LngLat: Equatable, Sendable, Codable {
    public let lon: Double
    public let lat: Double
    public init(_ lon: Double, _ lat: Double) {
        self.lon = lon
        self.lat = lat
    }
}

public enum Geo {
    static let radius = 6_371_008.8
    static func rad(_ d: Double) -> Double { d * .pi / 180 }

    /// Great-circle distance in metres. Correct across the 180 degree meridian.
    public static func distance(_ a: LngLat, _ b: LngLat) -> Double {
        let dLat = rad(b.lat - a.lat)
        let dLon = rad(b.lon - a.lon)
        let h = pow(sin(dLat / 2), 2) + cos(rad(a.lat)) * cos(rad(b.lat)) * pow(sin(dLon / 2), 2)
        return 2 * radius * asin(min(1, sqrt(h)))
    }

    /// Initial bearing from a to b, 0..<360 degrees.
    public static func bearing(_ a: LngLat, _ b: LngLat) -> Double {
        let y = sin(rad(b.lon - a.lon)) * cos(rad(b.lat))
        let x = cos(rad(a.lat)) * sin(rad(b.lat)) - sin(rad(a.lat)) * cos(rad(b.lat)) * cos(rad(b.lon - a.lon))
        return (atan2(y, x) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
    }
}
