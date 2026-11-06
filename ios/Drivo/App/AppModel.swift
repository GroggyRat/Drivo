import DrivoCore
import Foundation
import Supabase

@MainActor
final class AppModel: ObservableObject {
    @Published var signedIn = Repository.shared.userId != nil
    @Published var loading = false
    @Published var name = ""
    @Published var routes: [Route] = []
    @Published var online = true
    @Published var message: String?
    @Published var ledger: [LedgerEntry] = []
    @Published var waiting = 0

    private let repo = Repository.shared
    private var listening = false

    var active: Route? { routes.first { $0.status == "in_progress" } ?? routes.first { $0.status == "sent" } }

    func signIn(email: String, password: String) async {
        loading = true
        message = nil
        do {
            try await repo.signIn(email: email, password: password)
            if repo.membership == nil {
                await repo.signOut()
                message = "This account is not a driver. Ask your dispatcher to add you as a driver."
            } else {
                signedIn = true
                await refresh()
            }
        } catch {
            message = "That email and password do not match. Check them and try again."
        }
        loading = false
    }

    func signOut() async {
        LocationTracker.shared.stop()
        await repo.signOut()
        signedIn = false
        routes = []
    }

    /// Today's run (saved for no signal), the ledger, and KaiWorkforce clock-in and clock-out.
    func refresh() async {
        loading = true
        let m = try? await repo.loadMembership()
        let (r, isOnline) = await repo.todaysRoutes()
        routes = r
        online = isOnline
        name = m?.fullName ?? name
        await reloadLedger()
        loading = false
        if let m { listenForShifts(tenantId: m.tenantId) }
    }

    func reloadLedger() async {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = Config.fiji
        ledger = await repo.store.ledger(since: cal.startOfDay(for: Date()))
        waiting = await repo.store.waitingCount
    }

    private func listenForShifts(tenantId: String) {
        guard !listening else { return }
        listening = true
        Task {
            let channel = repo.client.channel("tenant:\(tenantId)")
            let shifts = channel.broadcastStream(event: "shift")
            await channel.subscribe()
            for await message in shifts {
                guard case let .object(payload) = message["payload"] ?? .object(message),
                      case let .string(driver)? = payload["driver_id"], driver == repo.userId else { continue }
                if case .bool(true)? = payload["tracking"] { LocationTracker.shared.start(vehicleId: active?.vehicleId) }
                else { LocationTracker.shared.stop() }
            }
        }
    }

    func startRoute(_ route: Route) async {
        LocationTracker.shared.requestPermission()
        do {
            let result = try await repo.startRoute(route.id)
            if result.tracking { LocationTracker.shared.start(vehicleId: route.vehicleId) }
            await refresh()
        } catch {
            message = "Could not start the route. Check your signal and try again."
        }
    }

    func complete(route: Route, stop: Stop, proof: ProofInput) async {
        await repo.complete(route: route, stop: stop, proof: proof)
        if let r = routes.firstIndex(where: { $0.id == route.id }), let s = routes[r].stops.firstIndex(where: { $0.id == stop.id }) {
            routes[r].stops[s].status = proof.outcome
        }
        if routes.first(where: { $0.id == route.id })?.nextStop == nil { LocationTracker.shared.stop() }
        await reloadLedger()
    }

    func dropPin(_ pin: PinInput) async {
        await repo.dropPin(pin)
        message = "Pin saved. It will be sent for review."
        await reloadLedger()
    }
}
