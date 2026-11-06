import DrivoCore
import Foundation
import Supabase

/// Everything the driver app reads and writes. Reads go to Supabase and fall
/// back to the copy saved at shift start; writes go into the offline store
/// first and are sent by SyncService, so nothing is lost without signal.
final class Repository: @unchecked Sendable {
    static let shared = Repository()

    let client = SupabaseClient(supabaseURL: Config.supabaseURL, supabaseKey: Config.supabaseKey)
    let store = OfflineStore.shared
    private(set) var membership: Membership?

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let s = try dec.singleValueContainer().decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = f.date(from: s) { return date }
            f.formatOptions = [.withInternetDateTime]
            if let date = f.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "Bad date \(s)"))
        }
        return d
    }()

    var userId: String? { client.auth.currentUser?.id.uuidString.lowercased() }

    func signIn(email: String, password: String) async throws {
        try await client.auth.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
        _ = try await loadMembership()
    }

    func signOut() async {
        try? await client.auth.signOut()
        membership = nil
    }

    /// The driver's company (the first, for a driver in more than one).
    func loadMembership() async throws -> Membership? {
        guard let id = userId else { return nil }
        let rows: [Membership] = try await client.from("memberships")
            .select("tenant_id, role, full_name")
            .eq("user_id", value: id).eq("role", value: "driver").eq("active", value: true)
            .execute().value
        membership = rows.first
        return membership
    }

    static func today() -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = Config.fiji
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }

    /// Today's routes, saved for no signal. Returns whether they came from the server.
    func todaysRoutes() async -> ([Route], Bool) {
        let date = Self.today()
        do {
            let data = try await client.from("routes")
                .select("id, name, status, route_date, vehicle_id, planned_distance_m, depot:depots(name, lon, lat), route_stops(id, sequence, status, planned_eta, location:locations(id, name, lon, lat, landmark_directions), order:orders(id, reference, customer_name, cartons, line_items, invoice_pdf_path, customer:customers(phone)))")
                .eq("route_date", value: date)
                .execute().data
            await store.saveRoutes(data, date: date)
            return ((try? decoder.decode([Route].self, from: data)) ?? [], true)
        } catch {
            guard let data = await store.routes(for: date) else { return ([], false) }
            return ((try? decoder.decode([Route].self, from: data)) ?? [], false)
        }
    }

    func settings() async -> TenantSettings? {
        try? await client.from("tenant_settings").select().single().execute().value
    }

    func speedLimits() async -> SpeedLimits? {
        guard let s = await settings() else { return nil }
        let zones: [SpeedZoneRow] = (try? await client.from("speed_zones").select("name, limit_kmh, area_geojson").eq("active", value: true).execute().value) ?? []
        return SpeedLimits(urbanKmh: s.urbanLimit, highwayKmh: s.highwayLimit, zones: zones.map { z in
            .init(name: z.name, limitKmh: z.limitKmh, polygons: z.area.coordinates.map { $0.map { $0.map { LngLat($0[0], $0[1]) } } })
        })
    }

    struct StartResult: Decodable { let tracking: Bool }

    private var tenantArg: [String: String] { membership.map { ["p_tenant_id": $0.tenantId] } ?? [:] }

    /// Whether to offer Clock in, and the open shift. Nil when offline.
    func myShift() async -> ShiftInfo? {
        try? await client.rpc("my_shift", params: tenantArg).execute().value
    }

    func clockIn() async throws -> ShiftInfo {
        try await client.rpc("clock_in", params: tenantArg).execute().value
    }

    func clockOut() async throws -> ShiftInfo {
        try await client.rpc("clock_out", params: tenantArg).execute().value
    }

    /// A five-minute link to an order's invoice PDF. Needs signal.
    func invoiceURL(path: String) async throws -> URL {
        try await client.storage.from("invoices").createSignedURL(path: path, expiresIn: 300)
    }

    /// Starting a route is online only: without KaiWorkforce it also starts tracking.
    func startRoute(_ routeId: String) async throws -> StartResult {
        try await client.rpc("start_route", params: ["p_route_id": routeId]).execute().value
    }

    func arrive(stopId: String, lon: Double?, lat: Double?) async {
        var p: [String: AnyJSON] = ["p_stop_id": .string(stopId)]
        if let lon, let lat { p["p_lon"] = .double(lon); p["p_lat"] = .double(lat) }
        await store.queue(PendingAction(id: UUID().uuidString.lowercased(), kind: .arriveStop, payload: p, fileName: nil))
        await SyncService.shared.syncSoon()
    }

    /// Photo and signature upload first; complete_stop follows with the same
    /// proof id, so a retry never records the delivery twice.
    func complete(route: Route, stop: Stop, proof: ProofInput) async {
        guard let tenant = membership?.tenantId else { return }
        let proofId = UUID().uuidString.lowercased()
        var photoPath: String?
        var signaturePath: String?
        if let photo = proof.photo {
            photoPath = "\(tenant)/\(stop.id)/photo.jpg"
            await queueUpload(photo, path: photoPath!, type: "image/jpeg", bucket: "delivery-proofs")
        }
        if let sig = proof.signaturePNG {
            signaturePath = "\(tenant)/\(stop.id)/signature.png"
            await queueUpload(sig, path: signaturePath!, type: "image/png", bucket: "delivery-proofs")
        }
        var p: [String: AnyJSON] = [
            "id": .string(proofId), "outcome": .string(proof.outcome),
            "captured_at": .string(ISO8601DateFormatter().string(from: Date())),
        ]
        if let v = proof.receivedBy { p["received_by"] = .string(v) }
        if let v = proof.notes { p["partial_notes"] = .string(v) }
        if let v = photoPath { p["photo_path"] = .string(v) }
        if let v = signaturePath { p["signature_path"] = .string(v) }
        if let lon = proof.lon, let lat = proof.lat { p["lon"] = .double(lon); p["lat"] = .double(lat) }
        if let a = proof.accuracyM { p["accuracy_m"] = .double(a) }
        await store.queue(PendingAction(id: proofId, kind: .completeStop, payload: ["p_stop_id": .string(stop.id), "p_proof": .object(p)], fileName: nil))
        await store.addLedger(LedgerEntry(stopId: stop.id, shopName: stop.location.name, reference: stop.order?.reference, outcome: proof.outcome,
                                          receivedBy: proof.receivedBy, cartons: stop.order?.cartons ?? 0, completedAt: Date(), synced: false))
        await SyncService.shared.syncSoon()
    }

    /// Drop a pin for a new shop, fuel stop or hazard. An Admin approves it.
    func dropPin(_ pin: PinInput) async {
        guard let tenant = membership?.tenantId else { return }
        let id = UUID().uuidString.lowercased()
        var photoPath: String?
        if let photo = pin.photo {
            photoPath = "\(tenant)/pins/\(id).jpg"
            await queueUpload(photo, path: photoPath!, type: "image/jpeg", bucket: "location-photos")
        }
        var p: [String: AnyJSON] = [
            "p_tenant_id": .string(tenant), "p_name": .string(pin.name), "p_type": .string(pin.type),
            "p_lon": .double(pin.lon), "p_lat": .double(pin.lat),
        ]
        if let a = pin.accuracyM { p["p_accuracy_m"] = .double(a) }
        if let d = pin.directions { p["p_landmark_directions"] = .string(d) }
        if let v = photoPath { p["p_photo_path"] = .string(v) }
        await store.queue(PendingAction(id: id, kind: .submitLocation, payload: p, fileName: nil))
        await SyncService.shared.syncSoon()
    }

    private func queueUpload(_ data: Data, path: String, type: String, bucket: String) async {
        let id = UUID().uuidString.lowercased()
        await store.queue(PendingAction(id: id, kind: .upload, payload: ["bucket": .string(bucket), "path": .string(path), "content_type": .string(type)], fileName: id), file: data)
    }
}
