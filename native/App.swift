import SwiftUI

@main
struct RAMGuardApp: App {
    @StateObject private var engine = RamEngine()
    init() {
        UserDefaults.standard.register(defaults: ["ramThresholdPct": RamEngine.defaultThreshold])
        Notifier.requestAuth()   // best-effort; pill + banner + dock bounce are the guaranteed warnings
    }
    var body: some Scene {
        Window("RAM Guard", id: "main") { MainWindow(engine: engine) }
            .windowResizability(.contentMinSize)        // resizable; min comes from MainWindow
            .defaultSize(width: 980, height: 680)
        MenuBarExtra {
            Dashboard(engine: engine).frame(width: 380, height: 470)   // compact popover
        } label: {
            Text(menuLabel)
        }
        .menuBarExtraStyle(.window)
    }
    private var menuLabel: String {
        guard engine.ram.valid else { return "—" }
        let pct = Int(engine.ram.usedPct)
        return engine.ram.usedPct >= RamEngine.threshold ? "! \(pct)%" : "\(pct)%"
    }
}
