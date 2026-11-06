import SwiftUI

/// Today's run: summary, the next stop, and every stop.
struct RunView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var tracker: LocationTracker
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !model.online { Badge(text: "No signal: showing the run saved at shift start", tone: .amber) }
                if let m = model.message { Text(m).foregroundStyle(DrivoColor.bad) }
                if let route = model.active {
                    summary(route)
                    if let next = route.nextStop { nextStop(route, next) }
                    Text("All stops").font(.drivoHeading)
                    ForEach(route.ordered) { s in
                        HStack(spacing: 12) {
                            Text("\(s.sequence)").font(.drivoHeading).foregroundStyle(DrivoColor.blue).frame(width: 24)
                            VStack(alignment: .leading) {
                                Text(s.location.name)
                                Text([s.order?.reference, s.plannedEta.map { "Planned \(fijiTime($0))" }].compactMap { $0 }.joined(separator: ", "))
                                    .font(.drivoSmall).foregroundStyle(DrivoColor.muted)
                            }
                            Spacer()
                            let (label, tone) = stopBadge(s.status)
                            Badge(text: label, tone: tone)
                        }
                        .padding(.vertical, 6)
                    }
                } else {
                    Panel { Text(model.loading ? "Loading your run" : "No route sent to you for today.").foregroundStyle(DrivoColor.muted) }
                }
            }
            .padding(16)
        }
        .background(DrivoColor.page)
        .navigationTitle("Today's run")
        .refreshable { await model.refresh() }
    }

    private func summary(_ route: Route) -> some View {
        let done = route.stops.filter { !$0.isOpen }.count
        let cartons = route.stops.compactMap { $0.order?.cartons }.reduce(0, +)
        return Panel {
            Text(route.name ?? "Route").font(.drivoHeading)
            Text("\(done) of \(route.stops.count) stops done, \(cartons) cartons, \(String(format: "%.1f", Double(route.plannedDistanceM ?? 0) / 1000)) km planned")
                .foregroundStyle(DrivoColor.muted)
            Badge(text: tracker.tracking ? "Sharing location" : "Not sharing location", tone: tracker.tracking ? .green : .grey)
            if route.status == "sent" {
                PrimaryButton(title: "Start route") { Task { await model.startRoute(route) } }
            }
        }
    }

    private func nextStop(_ route: Route, _ next: Stop) -> some View {
        let started = route.status == "in_progress"
        return Panel {
            Text("Next stop").font(.plex(12, .medium, relativeTo: .caption)).foregroundStyle(DrivoColor.muted)
            Text("\(next.sequence). \(next.location.name)").font(.drivoHeading)
            if let o = next.order { Text("\(o.reference), \(o.cartons) cartons").foregroundStyle(DrivoColor.muted) }
            if let d = next.location.directions { Text(d).foregroundStyle(DrivoColor.muted) }
            NavigationLink { NavigateView(stopId: next.id) } label: {
                Text("Start navigation").font(.drivoLabel).frame(maxWidth: .infinity, minHeight: 48)
                    .foregroundStyle(.white).background(started ? DrivoColor.black : DrivoColor.muted, in: RoundedRectangle(cornerRadius: 8))
            }
            .disabled(!started)
            HStack(spacing: 8) {
                let phone = next.order?.customer?.phone
                SecondaryButton(title: "Call", enabled: phone != nil) {
                    if let phone, let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") { openURL(url) }
                }
                NavigationLink { ArrivedView(stopId: next.id) } label: {
                    Text("Arrived").font(.drivoLabel).frame(maxWidth: .infinity, minHeight: 48)
                        .foregroundStyle(started ? DrivoColor.ink : DrivoColor.muted)
                        .background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
                }
                .disabled(!started)
            }
        }
    }
}
