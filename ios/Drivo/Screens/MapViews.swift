import DrivoCore
import MapLibre
import SwiftUI

/// MapLibre map (MapProvider: style from DRIVO_MAP_STYLE_URL, the Fiji
/// Protomaps style on Cloudflare R2 in production). MapLibre keeps tiles it
/// has shown in its cache for poor signal.
struct DrivoMap: UIViewRepresentable {
    var centre: LngLat
    var zoom: Double = 13
    var markers: [(LngLat, String)] = []
    var onMove: ((LngLat) -> Void)?

    func makeUIView(context: Context) -> MLNMapView {
        let map = MLNMapView(frame: .zero, styleURL: Config.mapStyleURL)
        map.setCenter(CLLocationCoordinate2D(latitude: centre.lat, longitude: centre.lon), zoomLevel: zoom, animated: false)
        map.showsUserLocation = true
        map.delegate = context.coordinator
        return map
    }

    func updateUIView(_ map: MLNMapView, context: Context) {
        map.removeAnnotations(map.annotations ?? [])
        for (p, title) in markers {
            let a = MLNPointAnnotation()
            a.coordinate = CLLocationCoordinate2D(latitude: p.lat, longitude: p.lon)
            a.title = title
            map.addAnnotation(a)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onMove: onMove) }

    final class Coordinator: NSObject, MLNMapViewDelegate {
        let onMove: ((LngLat) -> Void)?
        init(onMove: ((LngLat) -> Void)?) { self.onMove = onMove }
        func mapView(_ mapView: MLNMapView, regionDidChangeAnimated animated: Bool) {
            onMove?(LngLat(mapView.centerCoordinate.longitude, mapView.centerCoordinate.latitude))
        }
    }
}

/// The run on a map: every stop numbered.
struct MapTabView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        let route = model.active
        let centre = route?.nextStop.map { LngLat($0.location.lon, $0.location.lat) } ?? route.map { LngLat($0.depot.lon, $0.depot.lat) } ?? LngLat(178.4419, -18.1416)
        DrivoMap(centre: centre, zoom: 12.5, markers: route?.ordered.map { (LngLat($0.location.lon, $0.location.lat), "\($0.sequence). \($0.location.name), \(stopBadge($0.status).0)") } ?? [])
            .ignoresSafeArea(edges: .top)
    }
}
