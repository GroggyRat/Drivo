import Foundation

struct Membership: Codable, Equatable {
    let tenantId: String
    let role: String
    let fullName: String
    enum CodingKeys: String, CodingKey { case tenantId = "tenant_id", role, fullName = "full_name" }
}

struct StopLocation: Codable, Equatable, Hashable {
    let id: String
    let name: String
    let lon: Double
    let lat: Double
    let directions: String?
    enum CodingKeys: String, CodingKey { case id, name, lon, lat, directions = "landmark_directions" }
}

struct LineItem: Codable, Equatable, Hashable {
    let sku: String?
    let description: String
    let quantity: Double
    let unit: String?
}

struct StopCustomer: Codable, Equatable, Hashable { let phone: String? }

struct StopOrder: Codable, Equatable, Hashable {
    let id: String
    let reference: String
    let customerName: String
    let cartons: Int
    let lineItems: [LineItem]
    let customer: StopCustomer?
    var invoicePdfPath: String? = nil
    enum CodingKeys: String, CodingKey { case id, reference, cartons, customer, customerName = "customer_name", lineItems = "line_items", invoicePdfPath = "invoice_pdf_path" }
}

/// The driver's shift, from my_shift, clock_in and clock_out.
struct ShiftInfo: Codable, Equatable {
    /// False when the company clocks in through KaiWorkforce.
    let clockInHere: Bool
    let tracking: Bool
    let shift: OpenShift?
    enum CodingKeys: String, CodingKey { case tracking, shift, clockInHere = "clock_in_here" }
}

struct OpenShift: Codable, Equatable {
    let id: String
    let source: String
    let startedAt: Date
    enum CodingKeys: String, CodingKey { case id, source, startedAt = "started_at" }
}

struct Stop: Codable, Equatable, Hashable, Identifiable {
    let id: String
    let sequence: Int
    var status: String
    let plannedEta: Date?
    let location: StopLocation
    let order: StopOrder?
    enum CodingKeys: String, CodingKey { case id, sequence, status, location, order, plannedEta = "planned_eta" }

    var isOpen: Bool { status == "scheduled" || status == "arrived" }
}

struct Depot: Codable, Equatable, Hashable { let name: String; let lon: Double; let lat: Double }

struct Route: Codable, Equatable, Identifiable {
    let id: String
    let name: String?
    var status: String
    let routeDate: String
    let vehicleId: String?
    let plannedDistanceM: Int?
    let depot: Depot
    var stops: [Stop]
    enum CodingKeys: String, CodingKey {
        case id, name, status, depot
        case routeDate = "route_date", vehicleId = "vehicle_id", plannedDistanceM = "planned_distance_m", stops = "route_stops"
    }

    var ordered: [Stop] { stops.sorted { $0.sequence < $1.sequence } }
    var nextStop: Stop? { ordered.first { $0.isOpen } }
}

struct TenantSettings: Codable {
    let urbanLimit: Int
    let highwayLimit: Int
    let alertAfterS: Int
    let toleranceKmh: Int
    let arrivalRadiusM: Int
    enum CodingKeys: String, CodingKey {
        case urbanLimit = "urban_speed_limit_kmh", highwayLimit = "highway_speed_limit_kmh"
        case alertAfterS = "speed_alert_after_s", toleranceKmh = "speed_tolerance_kmh", arrivalRadiusM = "arrival_radius_m"
    }
}

struct SpeedZoneRow: Codable {
    let name: String
    let limitKmh: Int?
    let area: GeoJSONMultiPolygon
    enum CodingKeys: String, CodingKey { case name, limitKmh = "limit_kmh", area = "area_geojson" }
}

struct GeoJSONMultiPolygon: Codable { let coordinates: [[[[Double]]]] }

/// One line on the Day ledger.
struct LedgerEntry: Codable, Identifiable, Equatable {
    var id: String { stopId }
    let stopId: String
    let shopName: String
    let reference: String?
    let outcome: String
    let receivedBy: String?
    let cartons: Int
    let completedAt: Date
    var synced: Bool
}

/// A proof of delivery as the driver entered it.
struct ProofInput {
    /// delivered, partially_delivered or failed
    let outcome: String
    let receivedBy: String?
    let notes: String?
    let photo: Data?
    let signaturePNG: Data?
    let lon: Double?
    let lat: Double?
    let accuracyM: Double?
}

struct PinInput {
    let name: String
    /// shop, fuel, depot or hazard
    let type: String
    let lon: Double
    let lat: Double
    let accuracyM: Double?
    let directions: String?
    let photo: Data?
}
