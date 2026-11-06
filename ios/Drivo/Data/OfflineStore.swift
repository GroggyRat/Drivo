import DrivoCore
import Foundation
import Supabase

/// Work waiting for signal, kept in the app's Application Support folder so
/// it survives the app being closed. Sent in order by SyncService.
struct PendingAction: Codable, Identifiable {
    enum Kind: String, Codable { case upload, completeStop, arriveStop, submitLocation }
    let id: String
    let kind: Kind
    /// RPC parameters, or for uploads: bucket, path and content type.
    let payload: [String: AnyJSON]
    /// For uploads: the file in the store's files folder.
    let fileName: String?
    var attempts = 0
}

struct QueuedBatch: Codable, Identifiable {
    let id: String
    let tenantId: String
    let driverId: String
    let vehicleId: String?
    let points: [Fix]
}

actor OfflineStore {
    static let shared = OfflineStore()

    private let folder: URL
    private var batches: [QueuedBatch] = []
    private var actions: [PendingAction] = []
    private var ledger: [LedgerEntry] = []
    private var routes: [String: Data] = [:]

    init() {
        folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Drivo", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder.appendingPathComponent("files"), withIntermediateDirectories: true)
        batches = load("batches.json") ?? []
        actions = load("actions.json") ?? []
        ledger = load("ledger.json") ?? []
        routes = load("routes.json") ?? [:]
    }

    private func load<T: Decodable>(_ name: String) -> T? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func save<T: Encodable>(_ value: T, _ name: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: folder.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // GPS batches
    func queue(_ b: QueuedBatch) { batches.append(b); save(batches, "batches.json") }
    func pendingBatches() -> [QueuedBatch] { batches }
    func removeBatch(_ id: String) { batches.removeAll { $0.id == id }; save(batches, "batches.json") }

    // Deliveries, arrivals, pins and their files
    func queue(_ a: PendingAction, file: Data? = nil) {
        if let file, let name = a.fileName { try? file.write(to: folder.appendingPathComponent("files/\(name)")) }
        actions.append(a)
        save(actions, "actions.json")
    }
    func pendingActions() -> [PendingAction] { actions }
    func fileData(_ name: String) -> Data? { try? Data(contentsOf: folder.appendingPathComponent("files/\(name)")) }
    func removeAction(_ id: String) {
        if let name = actions.first(where: { $0.id == id })?.fileName { try? FileManager.default.removeItem(at: folder.appendingPathComponent("files/\(name)")) }
        actions.removeAll { $0.id == id }
        save(actions, "actions.json")
    }
    func actionFailed(_ id: String) {
        if let i = actions.firstIndex(where: { $0.id == id }) { actions[i].attempts += 1; save(actions, "actions.json") }
    }
    var waitingCount: Int { batches.count + actions.count }

    // Day ledger
    func addLedger(_ e: LedgerEntry) { ledger.removeAll { $0.stopId == e.stopId }; ledger.append(e); save(ledger, "ledger.json") }
    func markSynced(stopId: String) {
        if let i = ledger.firstIndex(where: { $0.stopId == stopId }) { ledger[i].synced = true; save(ledger, "ledger.json") }
    }
    func ledger(since: Date) -> [LedgerEntry] { ledger.filter { $0.completedAt >= since }.sorted { $0.completedAt > $1.completedAt } }

    // Today's routes, for no signal
    func saveRoutes(_ data: Data, date: String) { routes = [date: data]; save(routes, "routes.json") }
    func routes(for date: String) -> Data? { routes[date] }
}
