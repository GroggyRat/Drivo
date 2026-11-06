import BackgroundTasks
import DrivoCore
import Foundation
import Network
import Supabase

/// Sends everything waiting on the phone when there is a connection: GPS
/// batches first, then proof files, then deliveries and pins in order. Each
/// item is removed only after the server accepted it.
actor SyncService {
    static let shared = SyncService()
    static let taskId = "fj.kaitech.drivo.sync"

    private let monitor = NWPathMonitor()
    private var online = true
    private var running = false
    private var attempt = 0

    init() {
        monitor.pathUpdateHandler = { path in
            Task { await SyncService.shared.setOnline(path.status == .satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "drivo.network"))
    }

    private func setOnline(_ value: Bool) {
        online = value
        if value { Task { await sync() } }
    }

    func syncSoon() { Task { await sync() } }

    func sync() async {
        guard online, !running, Repository.shared.userId != nil else { return }
        running = true
        defer { running = false }
        let repo = Repository.shared
        let store = repo.store
        var failed = false

        for b in await store.pendingBatches() {
            do {
                let row: [String: AnyJSON] = [
                    "id": .string(b.id), "tenant_id": .string(b.tenantId), "driver_id": .string(b.driverId),
                    "vehicle_id": b.vehicleId.map(AnyJSON.string) ?? .null,
                    "recorded_from": .string(Self.iso(b.points.first!.timeMs)), "recorded_to": .string(Self.iso(b.points.last!.timeMs)),
                    "point_count": .integer(b.points.count),
                    "points": .array(b.points.map { .array($0.wire.map(AnyJSON.double)) }),
                ]
                try await repo.client.from("gps_batches").insert(row).execute()
                await store.removeBatch(b.id)
            } catch {
                // A retried upload that already arrived is a duplicate: done.
                if "\(error)".contains("duplicate key") { await store.removeBatch(b.id) } else { failed = true; break }
            }
        }

        for a in await store.pendingActions() where !failed {
            do {
                switch a.kind {
                case .upload:
                    if let name = a.fileName, let data = await store.fileData(name),
                       case let .string(bucket) = a.payload["bucket"], case let .string(path) = a.payload["path"], case let .string(type) = a.payload["content_type"] {
                        try await repo.client.storage.from(bucket).upload(path, data: data, options: FileOptions(contentType: type, upsert: true))
                    }
                case .completeStop:
                    try await repo.client.rpc("complete_stop", params: a.payload).execute()
                    if case let .string(stopId) = a.payload["p_stop_id"] { await store.markSynced(stopId: stopId) }
                case .arriveStop:
                    try await repo.client.rpc("arrive_stop", params: a.payload).execute()
                case .submitLocation:
                    try await repo.client.rpc("submit_location", params: a.payload).execute()
                }
                await store.removeAction(a.id)
            } catch {
                await store.actionFailed(a.id)
                // Keep order: a delivery must not be sent before its photo.
                failed = true
            }
        }

        if failed {
            let delay = retryDelaySeconds(attempt: attempt)
            attempt += 1
            Task {
                try? await Task.sleep(for: .seconds(delay))
                await self.sync()
            }
            scheduleBackground()
        } else {
            attempt = 0
        }
    }

    /// Ask iOS for background time to finish sending if the app is closed.
    nonisolated func scheduleBackground() {
        let request = BGProcessingTaskRequest(identifier: Self.taskId)
        request.requiresNetworkConnectivity = true
        try? BGTaskScheduler.shared.submit(request)
    }

    static func iso(_ ms: Int64) -> String {
        ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
}
