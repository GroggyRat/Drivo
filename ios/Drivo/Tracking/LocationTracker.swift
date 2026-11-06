import CoreLocation
import DrivoCore
import Foundation
import Supabase

/// Location while on shift. Starts on KaiWorkforce clock-in (Realtime
/// message) or, without KaiWorkforce, when the driver starts a route; stops at
/// clock-out or the last stop.
///
///  - Core Location at best-for-navigation accuracy, with background updates
///    (UIBackgroundModes: location) and the blue background indicator.
///  - DrivoCore drops fixes worse than 30 m and impossible jumps, keeps one fix
///    about every 4 s moving and 45 s parked, and closes a batch every ~45 s.
///  - Batches go to the offline store; SyncService uploads them.
///  - The live position is broadcast every 3 s; nothing is written per point.
@MainActor
final class LocationTracker: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = LocationTracker()

    @Published private(set) var tracking = false
    @Published private(set) var lastFix: Fix?
    @Published private(set) var speed = SpeedMonitor.State(speedKmh: 0, limitKmh: nil, over: false, alert: false)
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined

    private let manager = CLLocationManager()
    private var filter = FixFilter()
    private let sampling = SamplingPolicy()
    private var batcher = PointBatcher()
    private var monitor = SpeedMonitor()
    private var limits: SpeedLimits?
    private var channel: RealtimeChannelV2?
    private var lastKeptMs: Int64?
    private var lastBroadcastMs: Int64 = 0
    private var vehicleId: String?
    /// Fixes for screens that watch every kept fix (arrival geofence).
    var onFix: ((Fix) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        authorization = manager.authorizationStatus
    }

    func requestPermission() {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else if manager.authorizationStatus == .authorizedWhenInUse { manager.requestAlwaysAuthorization() }
    }

    /// While the app is open, for navigation and dropping pins without a shift.
    func startForeground() {
        manager.startUpdatingLocation()
    }

    func start(vehicleId: String?) {
        guard !tracking else { return }
        self.vehicleId = vehicleId
        requestPermission()
        filter = FixFilter()
        batcher = PointBatcher()
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
        tracking = true
        Task { await prepare() }
    }

    func stop() {
        guard tracking else { return }
        if let batch = batcher.flush() { queue(batch) }
        manager.allowsBackgroundLocationUpdates = false
        tracking = false
        Task { await channel?.unsubscribe() }
        channel = nil
    }

    private func prepare() async {
        let repo = Repository.shared
        guard let m = repo.membership ?? (try? await repo.loadMembership()) else { return }
        if let s = await repo.settings() { monitor = SpeedMonitor(afterMs: Int64(s.alertAfterS) * 1000, toleranceKmh: s.toleranceKmh) }
        limits = await repo.speedLimits()
        let ch = repo.client.channel("tenant:\(m.tenantId)")
        await ch.subscribe()
        channel = ch
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorization = status
            if status == .authorizedWhenInUse && self.tracking { manager.requestAlwaysAuthorization() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let fixes = locations.map { l in
            Fix(timeMs: Int64(l.timestamp.timeIntervalSince1970 * 1000), lon: l.coordinate.longitude, lat: l.coordinate.latitude,
                accuracyM: l.horizontalAccuracy, speedMps: l.speed >= 0 ? l.speed : nil, headingDeg: l.course >= 0 ? l.course : nil)
        }
        Task { @MainActor in fixes.forEach(self.handle) }
    }

    private func handle(_ fix: Fix) {
        guard case .kept = filter.accept(fix) else { return }
        // Moving: every fix ~4 s; parked: one every ~45 s. iOS has no
        // interval setting, so the distance filter widens when parked too.
        if sampling.onFix(fix) { manager.distanceFilter = sampling.intervalMs > 10_000 ? 20 : kCLDistanceFilterNone }
        guard sampling.isDue(fix, lastKeptMs: lastKeptMs) else { return }
        lastKeptMs = fix.timeMs
        lastFix = fix
        speed = monitor.onFix(fix, limitKmh: limits?.at(fix.position).kmh)
        onFix?(fix)
        guard tracking else { return }
        if let batch = batcher.add(fix) { queue(batch) }
        broadcast(fix)
    }

    private func queue(_ batch: Batch) {
        let repo = Repository.shared
        guard let tenant = repo.membership?.tenantId, let driver = repo.userId else { return }
        Task {
            await repo.store.queue(QueuedBatch(id: batch.id, tenantId: tenant, driverId: driver, vehicleId: vehicleId, points: batch.points))
            await SyncService.shared.syncSoon()
        }
    }

    private func broadcast(_ fix: Fix) {
        guard let channel, fix.timeMs - lastBroadcastMs >= 3_000, let driver = Repository.shared.userId else { return }
        lastBroadcastMs = fix.timeMs
        let message: JSONObject = [
            "driver_id": .string(driver), "lon": .double(fix.lon), "lat": .double(fix.lat),
            "speed_kmh": .integer(Int((fix.speedMps ?? 0) * 3.6)),
            "heading": fix.headingDeg.map(AnyJSON.double) ?? .null,
            "at": .string(SyncService.iso(fix.timeMs)),
        ]
        Task { try? await channel.broadcast(event: "position", message: message) }
    }
}
