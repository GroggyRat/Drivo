import CoreLocation
import FerrostarCore
import Foundation
import Supabase

/// Turn-by-turn with Ferrostar and our Valhalla. Routes come from Drivo's
/// backend (/api/navigation/route), which checks the driver's sign-in and
/// passes the request to the routing server; the routing key stays on the
/// server. Ferrostar provides the turn banner, rerouting and spoken
/// instructions. Built against Ferrostar 0.30: check these names when
/// upgrading, as its API still moves between releases.
@MainActor
enum Navigation {
    static let locationProvider = CoreLocationProvider(activityType: .automotiveNavigation, allowBackgroundLocationUpdates: true)

    static let core: FerrostarCore = {
        let config = SwiftNavigationControllerConfig(
            waypointAdvance: .waypointWithinRange(50),
            stepAdvance: .relativeLineStringDistance(minimumHorizontalAccuracy: 25, specialAdvanceConditions: nil),
            routeDeviationTracking: .staticThreshold(minimumHorizontalAccuracy: 25, maxAcceptableDeviation: 40),
            snappedLocationCourseFiltering: .snapToRoute
        )
        return try! FerrostarCore(
            valhallaEndpointUrl: Config.webURL.appendingPathComponent("api/navigation/route"),
            profile: "truck",
            locationProvider: locationProvider,
            navigationControllerConfig: config,
            networkSession: AuthorizedSession()
        )
    }()

    static let speech = AVSpeechSpokenInstructionObserver(isMuted: false)
}

/// Adds the driver's Supabase token to Ferrostar's route requests.
struct AuthorizedSession: URLRequestLoading {
    func loadData(with request: URLRequest) async throws -> (Data, URLResponse) {
        var r = request
        if let token = try? await Repository.shared.client.auth.session.accessToken {
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return try await URLSession.shared.data(for: r)
    }
}
