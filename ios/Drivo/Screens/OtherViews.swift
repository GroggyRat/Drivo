import DrivoCore
import SwiftUI

/// Drop a pin: move the map under the centre pin, then describe the place.
struct DropPinView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var tracker: LocationTracker
    @State private var centre: LngLat?
    @State private var name = ""
    @State private var type = "shop"
    @State private var directions = ""
    @State private var photo: UIImage?
    @State private var showCamera = false

    var body: some View {
        let start = tracker.lastFix?.position ?? LngLat(178.4419, -18.1416)
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Move the map so the pin sits on the shop's door.").foregroundStyle(DrivoColor.muted)
                ZStack {
                    DrivoMap(centre: start, zoom: 17, onMove: { centre = $0 })
                    Image(systemName: "mappin").font(.system(size: 34, weight: .semibold)).foregroundStyle(DrivoColor.bad).offset(y: -17)
                        .accessibilityLabel("Pin position")
                }
                .frame(height: 280).clipShape(RoundedRectangle(cornerRadius: 10))
                TextField("Name", text: $name).padding(12).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
                Picker("Type", selection: $type) {
                    Text("Shop").tag("shop"); Text("Fuel stop").tag("fuel"); Text("Depot").tag("depot"); Text("Hazard").tag("hazard")
                }
                .pickerStyle(.segmented)
                TextField("Directions and landmarks", text: $directions, axis: .vertical).lineLimit(2...4)
                    .padding(12).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
                SecondaryButton(title: photo == nil ? "Take photo" : "Photo taken. Take again") { showCamera = true }
                PrimaryButton(title: "Submit for review", enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty) {
                    let p = centre ?? start
                    Task {
                        await model.dropPin(PinInput(name: name.trimmingCharacters(in: .whitespaces), type: type, lon: p.lon, lat: p.lat,
                                                     accuracyM: tracker.lastFix?.accuracyM, directions: directions.isEmpty ? nil : directions,
                                                     photo: photo?.jpegData(compressionQuality: 0.7)))
                        name = ""; directions = ""; photo = nil
                    }
                }
                if let m = model.message { Text(m).foregroundStyle(DrivoColor.ok) }
            }
            .padding(16)
        }
        .background(DrivoColor.page)
        .navigationTitle("Drop a pin")
        .sheet(isPresented: $showCamera) { CameraPicker(image: $photo).ignoresSafeArea() }
        .onAppear { tracker.startForeground() }
    }
}

/// Day ledger: totals, and every delivery with whether it reached the office.
struct LedgerView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        let e = model.ledger
        List {
            Section {
                Text("\(e.filter { $0.outcome == "delivered" }.count) delivered, \(e.filter { $0.outcome == "partially_delivered" }.count) part delivered, \(e.filter { $0.outcome == "failed" }.count) not delivered")
                Text("\(e.filter { $0.outcome != "failed" }.map(\.cartons).reduce(0, +)) cartons delivered").foregroundStyle(DrivoColor.muted)
            }
            Section("Deliveries") {
                ForEach(e) { entry in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(entry.shopName)
                            Text([fijiTime(entry.completedAt), entry.reference, entry.receivedBy.map { "received by \($0)" }].compactMap { $0 }.joined(separator: ", "))
                                .font(.drivoSmall).foregroundStyle(DrivoColor.muted)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            let (label, tone) = stopBadge(entry.outcome)
                            Badge(text: label, tone: tone)
                            Badge(text: (entry.synced ? SyncStatus.synced : SyncStatus.waiting).rawValue, tone: entry.synced ? .green : .amber)
                        }
                    }
                }
            }
        }
        .navigationTitle("Day ledger")
        .refreshable { await model.reloadLedger() }
        .task { await model.reloadLedger() }
    }
}

struct AccountView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var tracker: LocationTracker
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Panel {
                    Text(model.name).font(.drivoHeading)
                    Badge(text: tracker.tracking ? "Sharing location while on shift" : "Not sharing location", tone: tracker.tracking ? .green : .grey)
                }
                Panel {
                    Text("Waiting to sync").font(.drivoHeading)
                    Text(model.waiting == 0 ? "Everything is sent." : "\(model.waiting) items will send when there is signal.").foregroundStyle(DrivoColor.muted)
                    SecondaryButton(title: "Refresh today's run") { Task { await model.refresh() } }
                }
                SecondaryButton(title: "Sign out", enabled: model.waiting == 0 || !tracker.tracking) { Task { await model.signOut() } }
                if model.waiting > 0 { Text("Sign out after everything has synced, so nothing is lost.").foregroundStyle(DrivoColor.muted) }
            }
            .padding(16)
        }
        .background(DrivoColor.page)
        .navigationTitle("Account")
        .task { await model.reloadLedger() }
    }
}
