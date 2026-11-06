import BackgroundTasks
import SwiftUI

@main
struct DrivoApp: App {
    @StateObject private var model = AppModel()

    init() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: SyncService.taskId, using: nil) { task in
            Task {
                await SyncService.shared.sync()
                task.setTaskCompleted(success: true)
            }
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if model.signedIn { RootView() } else { SignInView() }
            }
            .environmentObject(model)
            .environmentObject(LocationTracker.shared)
            .font(.drivoBody)
            .tint(DrivoColor.blue)
            .preferredColorScheme(.light)
        }
    }
}

/// Bottom tabs on every driver screen: Run, Map, Ledger, Drop pin, Account.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        TabView {
            NavigationStack { RunView() }.tabItem { Label("Run", systemImage: "list.bullet.rectangle") }
            MapTabView().tabItem { Label("Map", systemImage: "map") }
            NavigationStack { LedgerView() }.tabItem { Label("Ledger", systemImage: "checklist") }
            NavigationStack { DropPinView() }.tabItem { Label("Drop pin", systemImage: "mappin.and.ellipse") }
            NavigationStack { AccountView() }.tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .task { await model.refresh() }
    }
}
