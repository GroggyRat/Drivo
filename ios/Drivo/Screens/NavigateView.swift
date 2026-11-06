import CoreLocation
import DrivoCore
import FerrostarCore
import FerrostarCoreFFI
import FerrostarMapLibreUI
import MapLibreSwiftUI
import SwiftUI

/// In-app navigation to the next stop: Ferrostar's map with the route line,
/// turn banner, rerouting and voice with Mute; the speed readout beside the
/// limit; the following stop; and the arrival geofence.
struct NavigateView: View {
    let stopId: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var tracker: LocationTracker
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var core = Navigation.core
    @State private var camera: MapViewCamera = .automotiveNavigation()
    @State private var error: String?
    @State private var muted = false
    @State private var arrived = false
    @State private var detector: ArrivalDetector?

    var body: some View {
        let route = model.active
        let stop = route?.stops.first { $0.id == stopId }
        let following = route?.ordered.first { s in (s.sequence > (stop?.sequence ?? .max)) && s.status == "scheduled" }
        ZStack(alignment: .bottom) {
            DynamicallyOrientingNavigationView(
                styleURL: Config.mapStyleURL,
                camera: $camera,
                navigationState: core.state,
                isMuted: muted,
                onTapMute: toggleMute,
                onTapExit: { core.stopNavigation(); dismiss() }
            )
            VStack(alignment: .leading, spacing: 8) {
                if let error { Text(error).foregroundStyle(.white).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(DrivoColor.navy) }
                Spacer()
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        SpeedReadout(speedKmh: tracker.speed.speedKmh, limitKmh: tracker.speed.limitKmh, alert: tracker.speed.alert)
                        if let following {
                            Text("Then: \(following.location.name)").foregroundStyle(DrivoColor.muted)
                                .padding(.horizontal, 8).padding(.vertical, 4).background(.white.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                    Spacer()
                    VStack(spacing: 8) {
                        SecondaryButton(title: muted ? "Unmute voice" : "Mute voice", action: toggleMute)
                        NavigationLink { ArrivedView(stopId: stopId) } label: {
                            Text("Arrived").font(.drivoLabel).frame(maxWidth: .infinity, minHeight: 48).foregroundStyle(DrivoColor.ink)
                                .background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
                        }
                    }
                    .frame(width: 150)
                }
                .padding(16)
            }
        }
        .navigationBarBackButtonHidden()
        .navigationDestination(isPresented: $arrived) { ArrivedView(stopId: stopId) }
        .task { await start(stop) }
        .onAppear {
            tracker.startForeground()
            tracker.onFix = { fix in
                if detector?.onFix(fix) == .arrived { arrived = true }
            }
        }
        .onDisappear { tracker.onFix = nil }
    }

    /// Ferrostar's own mute button and ours both land here.
    private func toggleMute() {
        muted.toggle()
        if Navigation.speech.isMuted != muted { Navigation.speech.toggleMute() }
    }

    private func start(_ stop: Stop?) async {
        guard let stop else { return }
        detector = ArrivalDetector(target: LngLat(stop.location.lon, stop.location.lat))
        Navigation.core.spokenInstructionObserver = Navigation.speech
        guard let here = Navigation.locationProvider.lastLocation ?? tracker.lastFix.map({ f in
            UserLocation(clLocation: CLLocation(latitude: f.lat, longitude: f.lon))
        }) else {
            error = "Waiting for your location. Step outside or check that location is on."
            return
        }
        do {
            let routes = try await Navigation.core.getRoutes(initialLocation: here, waypoints: [
                Waypoint(coordinate: GeographicCoordinate(lat: stop.location.lat, lng: stop.location.lon), kind: .break),
            ])
            guard let first = routes.first else { throw URLError(.cannotFindHost) }
            try Navigation.core.startNavigation(route: first)
        } catch {
            self.error = "Could not get directions. The route line shows when there is signal."
        }
    }
}
