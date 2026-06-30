import SwiftUI
import AppKit
import Darwin
import UserNotifications

// MARK: - Data
struct PidRef: Equatable { let pid: Int32; let start: Double }   // start = kernel p_starttime (pid-reuse guard)
struct AppProc: Identifiable, Equatable {
    let id: Int32            // representative (biggest) pid — UI row identity
    let name: String
    let rssMb: Double
    let members: [PidRef]    // ALL pids in the app group (C2: quit the app, not one helper)
}
struct RamInfo: Equatable {
    var valid: Bool = true   // false -> show "—", never a false 100% (H3)
    var usedPct: Double = 0; var usedGb: Double = 0; var totalGb: Double = 0
    var freeMb: Double = 0; var compressorMb: Double = 0
}

// MARK: - Engine (true memory pressure via the kernel + ps for per-app hogs)
final class RamEngine: ObservableObject {
    @Published var ram = RamInfo()
    @Published var procs: [AppProc] = []
    @Published var overThreshold = false      // drives the in-app banner + threshold-tied pill
    static let defaultThreshold = 85.0
    private var timer: Timer?
    private var armed = true                   // ready to fire; re-arms only after dropping 5% below (hysteresis)
    private var primed = false                 // suppress a warning on launch if already over
    private var lastThreshold = RamEngine.defaultThreshold

    init() {
        tick()
        // @StateObject inits on main, so this timer attaches to the main run loop and fires (H2)
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.tick() }
    }
    deinit { timer?.invalidate() }   // H2: no orphan timer firing after the engine deallocs

    func tick() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let r = RamEngine.readRam(); let p = RamEngine.topProcs()
            DispatchQueue.main.async { self?.ram = r; self?.procs = p; self?.checkThreshold() }
        }
    }

    // The user's memory line (UserDefaults-backed; the slider writes the same key). Default 85%.
    static var threshold: Double {
        let v = UserDefaults.standard.object(forKey: "ramThresholdPct") as? Double ?? defaultThreshold
        return min(95, max(50, v))
    }
    // Fire ONCE when memory crosses the threshold upward; re-arm only after it drops 5% below
    // (hysteresis — no flapping). Never fire on launch-while-already-over or on a slider change.
    private func checkThreshold() {
        let t = RamEngine.threshold
        let over = ram.valid && ram.usedPct >= t
        overThreshold = over
        if !primed || t != lastThreshold {              // first tick, or the user just moved the slider:
            primed = true; lastThreshold = t; armed = !over   // re-seed silently, don't warn
            return
        }
        if over && armed { armed = false; warn(pct: ram.usedPct, threshold: t) }
        if ram.usedPct < t - 5 { armed = true }         // re-arm once safely back under the line
    }
    // Guaranteed warning (works on any signing level): bounce the dock + the in-app banner/pill react.
    // The system notification is a best-effort bonus (ad-hoc-signed apps often have it suppressed).
    private func warn(pct: Double, threshold: Double) {
        NSApp.requestUserAttention(.informationalRequest)
        Notifier.warn(pct: pct, threshold: threshold)
    }

    // Confirm-guarded, like the Electron app — quitting an app is NOT "safe on disk".
    func quit(_ p: AppProc) {
        guard confirm("Quit \(p.name)?", "Save your work first. Quitting closes the app and you may lose anything unsaved.") else { return }
        signalGroup(p)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.tick() }
    }
    func freeUp() {
        let top = Array(procs.prefix(2))
        guard !top.isEmpty else { return }
        let names = top.map { $0.name }.joined(separator: " and ")
        guard confirm("Free up RAM?", "This quits your 2 biggest apps (\(names)). Save your work first.") else { return }
        for p in top { signalGroup(p) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.tick() }
    }

    // C1 + C2: signal EVERY pid in the app group, but re-validate each pid's start-time
    // right before kill so a recycled pid can't take a SIGTERM meant for a process that already died.
    private func signalGroup(_ p: AppProc) {
        for m in p.members {
            guard let now = RamEngine.startKey(m.pid), now == m.start else { continue }  // gone or recycled -> skip
            if kill(m.pid, SIGTERM) != 0 {
                let e = errno   // ESRCH = already gone, EPERM = not permitted
                FileHandle.standardError.write(Data("RAMGuard: kill \(m.pid) failed, errno \(e)\n".utf8))
            }
        }
    }

    private func confirm(_ title: String, _ detail: String) -> Bool {
        let a = NSAlert(); a.messageText = title; a.informativeText = detail; a.alertStyle = .warning
        a.addButton(withTitle: "Quit app"); a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        return a.runModal() == .alertFirstButtonReturn
    }

    // Kernel process start-time as a stable key — same pid + same start = same process (C1).
    static func startKey(_ pid: Int32) -> Double? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let t = info.kp_proc.p_starttime
        return Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000
    }

    // True memory pressure straight from the kernel — no vm_stat subprocess (kills H1 + H3 for the RAM read).
    static func readRam() -> RamInfo {
        let total = Double(ProcessInfo.processInfo.physicalMemory)
        var stats = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
        let kr = withUnsafeMutablePointer(to: &stats) { p in
            p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard kr == KERN_SUCCESS, total > 0 else { return RamInfo(valid: false) }   // sentinel — show "—", never a false 100%
        var pageSize: vm_size_t = 0; host_page_size(mach_host_self(), &pageSize)
        let page = Double(pageSize)
        let wired = Double(stats.wire_count) * page
        let compressed = Double(stats.compressor_page_count) * page                       // compressed pages ARE pressure (H3)
        let appMem = Double(Int64(stats.internal_page_count) - Int64(stats.purgeable_count)) * page
        let used = max(wired + compressed + appMem, 0)                                    // ~ Activity Monitor "Memory Used"
        let free = (Double(stats.free_count) + Double(stats.inactive_count) + Double(stats.speculative_count)) * page
        return RamInfo(valid: true, usedPct: min(used / total * 100, 100),
                       usedGb: used / 1_073_741_824, totalGb: total / 1_073_741_824,
                       freeMb: free / 1_048_576, compressorMb: compressed / 1_048_576)
    }

    static let system: Set<String> = ["kernel_task","WindowServer","launchd","logd","loginwindow","mds","mds_stores","mdworker","mdworker_shared","coreaudiod","cfprefsd","distnoted","hidd","powerd"]
    static func appName(_ comm: String) -> String {
        if let r = comm.range(of: #"/[^/]+\.app/"#, options: .regularExpression) {
            return String(comm[r].dropFirst().dropLast(5))   // "/Name.app/" -> "Name"
        }
        return comm.split(separator: "/").last.map(String.init) ?? comm
    }
    static func topProcs() -> [AppProc] {
        let out = shell("/bin/ps", ["-axo", "pid=,rss=,comm="])
        var groups: [String: (rss: Double, top: Int32, topRss: Double, members: [PidRef])] = [:]
        for raw in out.split(separator: "\n") {
            let parts = raw.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
            guard parts.count >= 3, let pid = Int32(parts[0]), let rss = Double(parts[1]) else { continue }
            let name = appName(String(parts[2]))
            if system.contains(name) { continue }
            let rssMb = rss / 1024
            let ref = PidRef(pid: pid, start: startKey(pid) ?? 0)
            if var g = groups[name] {
                g.rss += rssMb; g.members.append(ref)
                if rssMb > g.topRss { g.topRss = rssMb; g.top = pid }
                groups[name] = g
            } else { groups[name] = (rssMb, pid, rssMb, [ref]) }
        }
        return groups.map { AppProc(id: $0.value.top, name: $0.key, rssMb: $0.value.rss, members: $0.value.members) }
            .sorted { $0.rssMb > $1.rssMb }.prefix(8).map { $0 }
    }
}

// MARK: - Notifications (best-effort; the pill + in-app banner are the guaranteed warnings)
enum Notifier {
    // Ad-hoc-signed apps can have flaky notification delivery, so this is a bonus on top of the
    // always-works pill/banner. Guard on a real bundle id to avoid UN crashing outside a bundle.
    static func requestAuth() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
    static func warn(pct: Double, threshold: Double) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let c = UNMutableNotificationContent()
        c.title = "RAM Guard"
        c.body = String(format: "Memory at %.0f%% — over your %.0f%% limit.", pct, threshold)
        c.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "ram-over-\(Int(Date().timeIntervalSince1970))", content: c, trigger: nil))
    }
}

// MARK: - Theme (dark "command deck" — charcoal + gold + bone; matches RAM Guard's own handoff palette)
extension Color {
    static let rgBg      = Color(red: 0.043, green: 0.043, blue: 0.051)   // #0B0B0D window
    static let rgPanel   = Color(red: 0.086, green: 0.086, blue: 0.098)   // #161619 row card
    static let rgPanel2  = Color(red: 0.118, green: 0.118, blue: 0.133)   // #1E1E22 track/elevated
    static let rgLine    = Color(red: 0.165, green: 0.165, blue: 0.188)   // #2A2A30 hairline
    static let rgBone    = Color(red: 0.957, green: 0.945, blue: 0.925)   // #F4F1EC primary text
    static let rgMute    = Color(red: 0.604, green: 0.584, blue: 0.549)   // #9A958C secondary text
    static let rgGold    = Color(red: 0.820, green: 0.706, blue: 0.498)   // #D1B47F accent (bright on dark)
    static let rgInk     = Color(red: 0.043, green: 0.043, blue: 0.051)   // text ON gold
    static let rgDanger  = Color(red: 0.914, green: 0.435, blue: 0.337)   // #E96F56 warm red, readable on dark
}

// MARK: - UI
struct Dashboard: View {
    @ObservedObject var engine: RamEngine
    @AppStorage("ramThresholdPct") private var threshold = RamEngine.defaultThreshold
    private var barColor: Color {
        engine.ram.usedPct >= threshold ? .rgDanger : engine.ram.usedPct >= threshold - 12 ? Color(red: 0.92, green: 0.70, blue: 0.36) : .rgGold
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 8) {
                Circle().fill(barColor).frame(width: 9, height: 9).shadow(color: barColor.opacity(0.7), radius: 4)
                Text("RAM Guard").font(.system(size: 17, weight: .bold)).foregroundColor(.rgBone)
                Spacer()
                Text(engine.ram.valid ? String(format: "%.0f%%", engine.ram.usedPct) : "—")
                    .font(.system(size: 15, weight: .semibold, design: .rounded)).foregroundColor(barColor)
            }
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 9).fill(Color.rgPanel2).frame(height: 18)
                GeometryReader { g in
                    RoundedRectangle(cornerRadius: 9)
                        .fill(LinearGradient(colors: [barColor.opacity(0.8), barColor], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(12, g.size.width * min(engine.ram.usedPct, 100) / 100), height: 18)
                        .shadow(color: barColor.opacity(0.55), radius: 7)
                        .animation(.easeOut(duration: 0.5), value: engine.ram.usedPct)
                }.frame(height: 18)
            }.frame(height: 18)
            Text(engine.ram.valid
                 ? String(format: "%.1f of %.0f GB used  ·  %.0f MB compressed", engine.ram.usedGb, engine.ram.totalGb, engine.ram.compressorMb)
                 : "reading memory…")
                .font(.system(size: 11)).foregroundColor(.rgMute)

            // Memory limit — warn me when usage crosses this line.
            HStack(spacing: 8) {
                Text("Alert above").font(.system(size: 11)).foregroundColor(.rgMute)
                Slider(value: $threshold, in: 50...95, step: 1).tint(.rgGold)
                Text("\(Int(threshold))%").font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundColor(.rgGold).frame(width: 38, alignment: .trailing)
            }

            if engine.overThreshold {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.rgDanger).font(.system(size: 12))
                    Text(String(format: "Over your %.0f%% limit", threshold)).font(.system(size: 12, weight: .medium)).foregroundColor(.rgBone)
                    Spacer()
                    GhostButton(title: "Free up", danger: true) { engine.freeUp() }
                }
                .padding(.vertical, 8).padding(.horizontal, 11)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color.rgDanger.opacity(0.14)))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.rgDanger.opacity(0.4), lineWidth: 1))
            }

            Text("BIGGEST MEMORY USERS").font(.system(size: 10, weight: .semibold)).tracking(1.2).foregroundColor(.rgMute).padding(.top, 2)
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(engine.procs) { p in
                        HStack {
                            Text(p.name).font(.system(size: 13, weight: .medium)).foregroundColor(.rgBone).lineLimit(1)
                            Spacer()
                            Text(String(format: "%.0f MB", p.rssMb)).font(.system(size: 12, design: .rounded)).foregroundColor(.rgMute)
                            GhostButton(title: "Quit") { engine.quit(p) }
                        }
                        .padding(.vertical, 8).padding(.horizontal, 11)
                        .background(RoundedRectangle(cornerRadius: 9).fill(Color.rgPanel))
                    }
                }
            }
            PrimaryButton(title: "Free up RAM") { engine.freeUp() }
        }
        .padding(16)
        .frame(minWidth: 340, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.rgBg)
        .preferredColorScheme(.dark)
    }
}

// The six sections of the big window, in sidebar order.
enum RGSection: String, CaseIterable, Identifiable {
    case ram = "RAM", junk = "Junk", large = "Large Files", apps = "Apps", login = "Login Items", storage = "Storage"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .ram: return "memorychip"
        case .junk: return "trash"
        case .large: return "doc.text.magnifyingglass"
        case .apps: return "square.grid.2x2"
        case .login: return "power"
        case .storage: return "internaldrive"
        }
    }
}

// Big resizable floating window (CleanMyMac-style): a left sidebar nav + large content area.
// Engines are owned HERE and injected, so switching sections keeps each section's scan state
// (no re-scan on every click). The menu-bar extra stays the compact RAM-only popover.
struct MainWindow: View {
    @ObservedObject var engine: RamEngine
    @StateObject private var junk = JunkEngine()
    @StateObject private var large = LargeFilesEngine()
    @StateObject private var apps = AppsEngine()
    @StateObject private var login = LoginItemsEngine()
    @StateObject private var storage = StorageEngine()
    @State private var section: RGSection = .ram
    @AppStorage("ramThresholdPct") private var threshold = RamEngine.defaultThreshold

    private var ramColor: Color {
        engine.ram.usedPct >= threshold ? .rgDanger : engine.ram.usedPct >= threshold - 12 ? Color(red: 0.92, green: 0.70, blue: 0.36) : .rgGold
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(Color.rgLine).frame(width: 1)
            content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(minWidth: 860, idealWidth: 980, maxWidth: .infinity, minHeight: 580, idealHeight: 680, maxHeight: .infinity)
        .background(Color.rgBg)
        .preferredColorScheme(.dark)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Circle().fill(ramColor).frame(width: 8, height: 8).shadow(color: ramColor.opacity(0.7), radius: 3)
                Text("RAM Guard").font(.system(size: 15, weight: .bold)).foregroundColor(.rgBone)
            }.padding(.bottom, 2)

            // Always-on mini memory gauge — the app's identity, visible from every section.
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("MEMORY").font(.system(size: 9, weight: .semibold)).tracking(1).foregroundColor(.rgMute)
                    Spacer()
                    Text(engine.ram.valid ? "\(Int(engine.ram.usedPct))%" : "—")
                        .font(.system(size: 12, weight: .semibold, design: .rounded)).foregroundColor(ramColor)
                }
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.rgPanel2).frame(height: 6)
                    GeometryReader { g in
                        Capsule().fill(ramColor)
                            .frame(width: max(4, g.size.width * min(engine.ram.usedPct, 100) / 100), height: 6)
                            .animation(.easeOut(duration: 0.5), value: engine.ram.usedPct)
                    }.frame(height: 6)
                }.frame(height: 6)
            }
            .padding(11)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.rgPanel))
            .padding(.vertical, 6)

            ForEach(RGSection.allCases) { s in
                Button { section = s } label: {
                    HStack(spacing: 10) {
                        Image(systemName: s.icon).font(.system(size: 13)).frame(width: 18)
                        Text(s.rawValue).font(.system(size: 13, weight: section == s ? .semibold : .regular))
                        Spacer()
                    }
                    .foregroundColor(section == s ? .rgGold : .rgMute)
                    .padding(.vertical, 8).padding(.horizontal, 10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(section == s ? Color.rgGold.opacity(0.14) : .clear))
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            Spacer()
            Text("v2 · native").font(.system(size: 10)).foregroundColor(.rgMute.opacity(0.6))
        }
        .padding(14)
        .frame(width: 210)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.rgBg)
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .ram: Dashboard(engine: engine)
        case .junk: JunkView(e: junk)
        case .large: LargeFilesView(e: large)
        case .apps: AppsView(e: apps)
        case .login: LoginView(e: login)
        case .storage: StorageView(e: storage)
        }
    }
}

// @main entry lives in App.swift (kept separate so the views can be compiled into an offline
// render harness for visual verification without the App's top-level scene).
