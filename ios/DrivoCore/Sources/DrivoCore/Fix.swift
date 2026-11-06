import Foundation

/// One location fix from the phone (Core Location on iOS, FusedLocationProvider on Android).
public struct Fix: Equatable, Sendable, Codable {
    public let timeMs: Int64
    public let lon: Double
    public let lat: Double
    /// Reported horizontal accuracy in metres.
    public let accuracyM: Double
    /// Speed over ground in m/s, when the device reported one.
    public let speedMps: Double?
    public let headingDeg: Double?

    public init(timeMs: Int64, lon: Double, lat: Double, accuracyM: Double, speedMps: Double?, headingDeg: Double?) {
        self.timeMs = timeMs
        self.lon = lon
        self.lat = lat
        self.accuracyM = accuracyM
        self.speedMps = speedMps
        self.headingDeg = headingDeg
    }

    public var position: LngLat { LngLat(lon, lat) }

    /// The upload format: [epoch_ms, lon, lat, accuracy_m, speed_mps, heading_deg].
    public var wire: [Double] { [Double(timeMs), lon, lat, accuracyM, speedMps ?? 0, headingDeg ?? 0] }
}
