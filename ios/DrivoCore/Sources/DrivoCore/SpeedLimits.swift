import Foundation

/// The same rule as the server: inside an active town zone, the zone's limit
/// or the urban limit; where zones overlap, the lowest; outside every zone,
/// the highway limit. Polygons are GeoJSON rings (outline first, then holes).
public struct SpeedLimits: Sendable {
    public struct Zone: Sendable {
        public let name: String
        public let limitKmh: Int?
        public let polygons: [[[LngLat]]]
        public init(name: String, limitKmh: Int?, polygons: [[[LngLat]]]) {
            self.name = name
            self.limitKmh = limitKmh
            self.polygons = polygons
        }
    }

    public struct Limit: Equatable, Sendable {
        public let kmh: Int
        public let zone: String?
    }

    let urbanKmh: Int
    let highwayKmh: Int
    let zones: [Zone]

    public init(urbanKmh: Int, highwayKmh: Int, zones: [Zone]) {
        self.urbanKmh = urbanKmh
        self.highwayKmh = highwayKmh
        self.zones = zones
    }

    public func at(_ p: LngLat) -> Limit {
        let inside = zones.filter { z in z.polygons.contains { Self.contains($0, p) } }
        guard let best = inside.min(by: { ($0.limitKmh ?? urbanKmh) < ($1.limitKmh ?? urbanKmh) }) else {
            return Limit(kmh: highwayKmh, zone: nil)
        }
        return Limit(kmh: best.limitKmh ?? urbanKmh, zone: best.name)
    }

    static func contains(_ polygon: [[LngLat]], _ p: LngLat) -> Bool {
        guard let outline = polygon.first else { return false }
        return inRing(outline, p) && !polygon.dropFirst().contains { inRing($0, p) }
    }

    static func inRing(_ ring: [LngLat], _ p: LngLat) -> Bool {
        var inside = false
        var j = ring.count - 1
        for i in ring.indices {
            let a = ring[i], b = ring[j]
            if (a.lat > p.lat) != (b.lat > p.lat), p.lon < (b.lon - a.lon) * (p.lat - a.lat) / (b.lat - a.lat) + a.lon {
                inside.toggle()
            }
            j = i
        }
        return inside
    }
}
