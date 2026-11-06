import SwiftUI

struct ArrivedView: View {
    let stopId: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var tracker: LocationTracker
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var startDelivery = false

    var body: some View {
        if let stop = model.active?.stops.first(where: { $0.id == stopId }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("You are at \(stop.location.name)").font(.drivoTitle)
                    if let o = stop.order { Text("\(o.reference), \(o.customerName), \(o.cartons) cartons").foregroundStyle(DrivoColor.muted) }
                    if let d = stop.location.directions { Panel { Text(d) } }
                    if let path = stop.order?.invoicePdfPath {
                        SecondaryButton(title: "Open invoice") { Task { if let url = await model.invoiceURL(path) { openURL(url) } } }
                    }
                    PrimaryButton(title: "Check in and start delivery") {
                        Task { await Repository.shared.arrive(stopId: stop.id, lon: tracker.lastFix?.lon, lat: tracker.lastFix?.lat) }
                        startDelivery = true
                    }
                    SecondaryButton(title: "Not here yet") { dismiss() }
                }
                .padding(24)
            }
            .background(DrivoColor.page)
            .navigationDestination(isPresented: $startDelivery) { ProofView(stopId: stopId) }
        }
    }
}
