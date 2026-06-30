import SwiftUI
import Foundation

private let DAY_MS = 24.0 * 60 * 60 * 1000
private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

// =====================================================================================
// MARK: - Junk (caches / logs / browser / trash) — Trash-only cleaning
// =====================================================================================
struct JunkCategory: Identifiable, Equatable {
    let id: String           // key
    let label: String; let detail: String
    var bytes: Double
    var selected: Bool
    let targets: [String]    // dirs whose CONTENTS get trashed; for 'trash' = [~/.Trash] (emptied)
    let isTrash: Bool
}

final class JunkEngine: ObservableObject {
    @Published var cats: [JunkCategory] = []
    @Published var busy = false
    @Published var lastFreed: Double? = nil

    static let allowedRoots = [Paths.j("Library","Caches"), Paths.j("Library","Logs"), Paths.j(".Trash")]
    private struct Spec { let key, label, detail, root: String; let sizeRoots: [String]; let sel, isTrash: Bool }
    private static let specs: [Spec] = [
        Spec(key: "userCaches", label: "User Caches", detail: "~/Library/Caches",
             root: Paths.j("Library","Caches"), sizeRoots: [Paths.j("Library","Caches")], sel: true, isTrash: false),
        Spec(key: "systemLogs", label: "Logs", detail: "~/Library/Logs",
             root: Paths.j("Library","Logs"), sizeRoots: [Paths.j("Library","Logs")], sel: true, isTrash: false),
        Spec(key: "browserData", label: "Browser Data", detail: "Safari & Chrome caches",
             root: Paths.j("Library","Caches"),
             sizeRoots: [Paths.j("Library","Caches","com.apple.Safari"),
                         Paths.j("Library","Caches","com.google.Chrome"),
                         Paths.j("Library","Caches","Google","Chrome")], sel: false, isTrash: false),
        Spec(key: "trash", label: "Trash", detail: "~/.Trash",
             root: Paths.j(".Trash"), sizeRoots: [Paths.j(".Trash")], sel: false, isTrash: true),
    ]

    func scan() {
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let rows = JunkEngine.specs.map { s -> JunkCategory in
                let bytes = duBytes(s.sizeRoots)
                let targets = s.key == "browserData" ? s.sizeRoots.filter { Paths.exists($0) } : [s.root]
                return JunkCategory(id: s.key, label: s.label, detail: s.detail, bytes: bytes, selected: s.sel, targets: targets, isTrash: s.isTrash)
            }
            DispatchQueue.main.async { self?.cats = rows; self?.busy = false }
        }
    }
    func toggle(_ id: String) { if let i = cats.firstIndex(where: { $0.id == id }) { cats[i].selected.toggle() } }

    @MainActor func clean() {
        let chosen = cats.filter { $0.selected && $0.bytes > 0 }
        guard !chosen.isEmpty else { return }
        let names = chosen.map { $0.label }.joined(separator: ", ")
        guard confirmDestructive("Clean \(names)?",
            "Selected items move to the Trash (the Trash category empties it). You can put files back from the Trash until you empty it.") else { return }
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var freed = 0.0
            for c in chosen {
                if c.isTrash {
                    guard Paths.isUnder(c.targets[0], roots: JunkEngine.allowedRoots) else { continue }
                    let before = duBytes(c.targets); Trash.empty(); let after = duBytes(c.targets)
                    freed += max(0, before - after)
                } else {
                    for dir in c.targets where Paths.isUnder(dir, roots: JunkEngine.allowedRoots) {
                        let before = duBytes([dir]); var moved = 0
                        for item in Paths.contents(dir) {
                            // per-item gate: skip symlinks (never follow OUT of the allowlist) and
                            // re-check containment on EACH child, not just the parent dir.
                            guard !Paths.isSymlink(item), Paths.isUnder(item, roots: JunkEngine.allowedRoots) else { continue }
                            if Trash.move(item) { moved += 1 }
                        }
                        if moved > 0 { freed += max(0, before - duBytes([dir])) }
                    }
                }
            }
            DispatchQueue.main.async { self?.lastFreed = freed; self?.busy = false; self?.scan() }
        }
    }
}

// =====================================================================================
// MARK: - Large & old files (100MB+, untouched 90d+) — reveal / trash
// =====================================================================================
struct LargeFile: Identifiable, Equatable {
    let id: String; let path, name, dir, category: String; let bytes: Double; let ageDays: Int
}

final class LargeFilesEngine: ObservableObject {
    @Published var files: [LargeFile] = []
    @Published var busy = false

    private static let roots: [(String,String)] = [
        (Paths.j("Downloads"),"Downloads"), (Paths.j("Movies"),"Movies"),
        (Paths.j("Documents"),"Documents"), (Paths.j("Desktop"),"Desktop"),
    ]
    static let trashRoots = ["Downloads","Movies","Documents","Desktop","Music","Pictures"].map { Paths.j($0) }

    func scan(minMB: Double = 100, minAgeDays: Int = 90, topN: Int = 100, maxHits: Int = 200) {
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let live = LargeFilesEngine.roots.filter { Paths.isDir($0.0) }
            guard !live.isEmpty else { DispatchQueue.main.async { self?.files = []; self?.busy = false }; return }
            let findOut = shell("/usr/bin/find", live.map { $0.0 } + ["-type","f","-size","+\(Int(minMB))M","-print0"], timeout: 8)
            let paths = Array(findOut.split(separator: "\0").map(String.init).filter { !$0.isEmpty }.prefix(maxHits))
            guard !paths.isEmpty else { DispatchQueue.main.async { self?.files = []; self?.busy = false }; return }
            let statMap = LargeFilesEngine.parseStat(shell("/usr/bin/stat", ["-f","%a|%z|%N"] + paths))
            let mdls = LargeFilesEngine.parseMdls(shell("/usr/bin/mdls", ["-name","kMDItemLastUsedDate","-name","kMDItemFSSize"] + paths), count: paths.count)
            let now = nowMs()
            var out: [LargeFile] = []
            for (i, p) in paths.enumerated() {
                guard let s = statMap[p] else { continue }
                let lastUsed = (mdls[i] ?? 0) > 0 ? mdls[i]! : s.atimeMs
                let age = lastUsed > 0 ? Int((now - lastUsed) / DAY_MS) : Int.max
                if s.bytes >= minMB * 1_048_576 && age >= minAgeDays {
                    let cat = LargeFilesEngine.roots.first { p.hasPrefix($0.0 + "/") }?.1 ?? "Other"
                    out.append(LargeFile(id: p, path: p, name: (p as NSString).lastPathComponent,
                                         dir: (p as NSString).deletingLastPathComponent, category: cat, bytes: s.bytes, ageDays: age))
                }
            }
            out.sort { $0.bytes > $1.bytes }
            let top = Array(out.prefix(topN))
            DispatchQueue.main.async { self?.files = top; self?.busy = false }
        }
    }

    struct StatRow { let atimeMs, bytes: Double }
    static func parseStat(_ out: String) -> [String: StatRow] {
        var map: [String: StatRow] = [:]
        for line in out.split(separator: "\n") {
            let s = String(line); guard let a = s.firstIndex(of: "|") else { continue }
            let rest = s.index(after: a); guard let b = s[rest...].firstIndex(of: "|") else { continue }
            guard let atime = Double(s[..<a]), let bytes = Double(s[rest..<b]) else { continue }
            let p = String(s[s.index(after: b)...]); if p.isEmpty { continue }
            map[p] = StatRow(atimeMs: atime * 1000, bytes: bytes)
        }
        return map
    }
    static func parseMdls(_ out: String, count: Int) -> [Double?] {
        var dates: [Double] = []
        for line in out.split(separator: "\n") {
            if let r = line.range(of: "kMDItemLastUsedDate") {
                let after = line[r.upperBound...]
                if let eq = after.firstIndex(of: "=") { dates.append(mdlsDateToMs(String(after[after.index(after: eq)...]))) }
            }
        }
        return (0..<count).map { $0 < dates.count ? dates[$0] : nil }
    }
    static func mdlsDateToMs(_ raw: String) -> Double {
        let s = raw.trimmingCharacters(in: .whitespaces)
        if s.isEmpty || s == "(null)" { return 0 }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        return f.date(from: s).map { $0.timeIntervalSince1970 * 1000 } ?? 0
    }

    func reveal(_ f: LargeFile) { _ = shell("/usr/bin/open", ["-R", f.path], timeout: 4) }

    @MainActor func trash(_ f: LargeFile) {
        guard validTarget(f.path) else { return }
        guard confirmDestructive("Move \(f.name) to Trash?",
            "\(fmtSize(f.bytes)) · last opened \(f.ageDays == Int.max ? "never" : "\(f.ageDays) days ago"). Recoverable from the Trash.") else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            _ = Trash.move(f.path)
            DispatchQueue.main.async { self?.scan() }
        }
    }
    // Absolute, existing, regular file, under an allowed user root.
    func validTarget(_ p: String) -> Bool {
        guard p.hasPrefix("/"), !Paths.isSymlink(p) else { return false }   // never trash a symlink
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: p, isDirectory: &isDir), !isDir.boolValue else { return false }
        return Paths.isUnder(p, roots: LargeFilesEngine.trashRoots)
    }
}

// =====================================================================================
// MARK: - Installed apps — uninstall (bundle + leftovers) to Trash
// =====================================================================================
struct AppInfo: Identifiable, Equatable {
    let id: String; let name, path: String; let bytes: Double; let bundleId: String?
    var detail: String { "\(Int(bytes/1_048_576)) MB · \((path.hasPrefix("/Applications")) ? "/Applications" : "~/Applications")" }
}

final class AppsEngine: ObservableObject {
    @Published var apps: [AppInfo] = []
    @Published var busy = false
    static let roots = ["/Applications", Paths.j("Applications")]

    func scan() {
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var bundles: [String] = []
            for root in AppsEngine.roots {
                for e in (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? [] where e.hasSuffix(".app") {
                    bundles.append(root + "/" + e)
                }
            }
            var out: [AppInfo] = []
            for b in bundles {
                let bytes = parseDuK(shell("/usr/bin/du", ["-sk", b], timeout: 6))
                if bytes <= 0 { continue }   // SIP-protected / permission-denied -> skip
                let bid = AppsEngine.parseBundleId(shell("/usr/bin/mdls", ["-name","kMDItemCFBundleIdentifier", b], timeout: 6))
                out.append(AppInfo(id: b, name: (b as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: ""), path: b, bytes: bytes, bundleId: bid))
            }
            out.sort { $0.bytes > $1.bytes }
            DispatchQueue.main.async { self?.apps = out; self?.busy = false }
        }
    }
    static func parseBundleId(_ out: String) -> String? {
        guard let r = out.range(of: #"kMDItemCFBundleIdentifier\s*=\s*"([^"]+)""#, options: .regularExpression) else { return nil }
        let frag = String(out[r])
        return frag.range(of: #""([^"]+)""#, options: .regularExpression).map { String(frag[$0]).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
    }
    func leftovers(_ app: AppInfo) -> [String] {
        var c = [Paths.j("Library","Application Support",app.name), Paths.j("Library","Caches",app.name), Paths.j("Library","Logs",app.name)]
        // sanitize the bundle id before interpolating it into paths — reject separators/.. so a
        // crafted CFBundleIdentifier can't build a path that climbs out of ~/Library.
        if let id = app.bundleId, !id.contains("/"), !id.contains("..") {
            c += [Paths.j("Library","Caches",id), Paths.j("Library","Preferences","\(id).plist"),
                  Paths.j("Library","Application Support",id), Paths.j("Library","Saved Application State","\(id).savedState")]
        }
        var seen = Set<String>(); return c.filter { seen.insert($0).inserted && Paths.exists($0) }
    }

    @MainActor func uninstall(_ app: AppInfo) {
        guard Paths.isUnder(app.path, roots: AppsEngine.roots), app.path.hasSuffix(".app"), Paths.exists(app.path) else { return }
        let extra = leftovers(app)
        let extraNote = extra.isEmpty ? "" : "\n\nAlso removes \(extra.count) leftover support/cache file\(extra.count == 1 ? "" : "s")."
        guard confirmDestructive("Uninstall \(app.name)?",
            "Moves the app (\(fmtSize(app.bytes))) to the Trash.\(extraNote) Recoverable from the Trash.", okTitle: "Uninstall") else { return }
        let lib = Paths.j("Library")
        DispatchQueue.global(qos: .utility).async { [weak self] in
            _ = Trash.move(app.path)
            for lo in extra where Paths.isUnder(lo, roots: [lib]) { _ = Trash.move(lo) }
            DispatchQueue.main.async { self?.scan() }
        }
    }
}

// =====================================================================================
// MARK: - Login items — list / remove (System Events, not a file delete)
// =====================================================================================
struct LoginItem: Identifiable, Equatable { let id: String; let name: String; let hidden: Bool }

final class LoginItemsEngine: ObservableObject {
    @Published var items: [LoginItem] = []
    @Published var busy = false

    func scan() {
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let out = shell("/usr/bin/osascript",
                ["-e","tell application \"System Events\" to get the name of every login item",
                 "-e","tell application \"System Events\" to get the hidden of every login item"], timeout: 6)
            let parsed = LoginItemsEngine.parse(out)
            DispatchQueue.main.async { self?.items = parsed; self?.busy = false }
        }
    }
    static func parse(_ out: String) -> [LoginItem] {
        let lines = out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !lines.isEmpty else { return [] }
        let names = lines[0].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let hidden = lines.count > 1 ? lines[1].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } : []
        return names.enumerated().map { i, n in LoginItem(id: n, name: n, hidden: (i < hidden.count ? hidden[i].lowercased() : "") == "true") }
    }
    // Reject quotes/backslashes AND every newline/control char (incl. U+2028/U+2029/U+0085) so a
    // crafted login-item name can't break out of the osascript double-quoted string literal.
    private func safeName(_ n: String) -> Bool {
        guard !n.isEmpty, n.count <= 256, n.range(of: #"[""\\]"#, options: .regularExpression) == nil else { return false }
        return n.unicodeScalars.allSatisfy { !CharacterSet.newlines.contains($0) && !CharacterSet.controlCharacters.contains($0) }
    }

    @MainActor func remove(_ item: LoginItem) {
        guard safeName(item.name), items.contains(where: { $0.name == item.name }) else { return }
        guard confirmDestructive("Stop \(item.name) opening at login?",
            "This only changes a startup setting — it does not delete the app.", okTitle: "Stop at Login") else { return }
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            _ = shell("/usr/bin/osascript", ["-e","tell application \"System Events\" to delete login item \"\(item.name)\""], timeout: 6)
            DispatchQueue.main.async { self?.busy = false; self?.scan() }
        }
    }
}

// =====================================================================================
// MARK: - Storage breakdown (read-only stacked bar)
// =====================================================================================
struct StorageSlice: Identifiable { let id: String; let label: String; let bytes: Double; let color: Color }
struct StorageInfo: Equatable {
    var totalGb = 0.0, usedGb = 0.0, freeGb = 0.0, usedPct = 0.0
    var slices: [StorageSliceData] = []
}
struct StorageSliceData: Equatable { let key, label: String; let bytes: Double }

final class StorageEngine: ObservableObject {
    @Published var info = StorageInfo()
    @Published var busy = false
    static let colors: [String: Color] = [
        "system": Color(red:0.54,green:0.50,blue:0.44), "applications": Color(red:0.79,green:0.64,blue:0.15),
        "documents": Color(red:0.42,green:0.50,blue:0.42), "junk": Color(red:0.71,green:0.40,blue:0.11),
        "free": Color(red:0.91,green:0.89,blue:0.82)]

    func scan() {
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let df = StorageEngine.parseDf(shell("/bin/df", ["-k","/System/Volumes/Data"], timeout: 4))
            let prof = StorageEngine.parseProfiler(shell("/usr/sbin/system_profiler", ["SPStorageDataType"], timeout: 6))
            let appsB = duBytes(["/Applications", Paths.j("Applications")])
            let docsB = duBytes(["Documents","Desktop","Movies","Music","Pictures"].map { Paths.j($0) })
            let junkB = duBytes([Paths.j("Library","Caches"), Paths.j("Library","Logs"), Paths.j(".Trash")])
            var total = df.0, used = df.1, free = df.2
            if total == 0, let c = prof.1 { total = c }
            if free == 0, let fb = prof.0 { free = fb }
            if used == 0, total > 0 { used = max(0, total - free) }
            let info = StorageEngine.buckets(total: total, used: used, free: free, apps: appsB, docs: docsB, junk: junkB)
            DispatchQueue.main.async { self?.info = info; self?.busy = false }
        }
    }
    // df -k row -> (total,used,free) bytes
    static func parseDf(_ out: String) -> (Double,Double,Double) {
        let rows = out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.lowercased().hasPrefix("filesystem") }
        guard let row = rows.first(where: { $0.hasSuffix("/System/Volumes/Data") }) ?? rows.last else { return (0,0,0) }
        let t = row.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard t.count > 3, let total = Double(t[1]), let used = Double(t[2]), let avail = Double(t[3]) else { return (0,0,0) }
        return (total*1024, used*1024, avail*1024)
    }
    // system_profiler Free/Capacity -> bytes (prefer the exact (N bytes) value)
    static func parseProfiler(_ out: String) -> (Double?, Double?) {
        func grab(_ label: String) -> Double? {
            guard let r = out.range(of: "\(label):\\s*(.+)", options: .regularExpression) else { return nil }
            let v = String(out[r])
            if let pr = v.range(of: #"\(([\d,]+)\s*bytes\)"#, options: .regularExpression) {
                let digits = String(v[pr]).filter { $0.isNumber }
                return Double(digits)
            }
            if let ur = v.range(of: #"([\d.]+)\s*(TB|GB|MB)"#, options: .regularExpression) {
                let s = String(v[ur]); let num = Double(s.filter { $0.isNumber || $0 == "." }) ?? 0
                let mult = s.contains("TB") ? 1_099_511_627_776.0 : s.contains("GB") ? 1_073_741_824.0 : 1_048_576.0
                return num * mult
            }
            return nil
        }
        return (grab("Free"), grab("Capacity"))
    }
    static func buckets(total: Double, used uIn: Double, free fIn: Double, apps: Double, docs: Double, junk: Double) -> StorageInfo {
        let t = max(0, total)
        let used = uIn > 0 ? uIn : max(0, t - max(0, fIn))
        let free = t > 0 ? max(0, t - used) : max(0, fIn)
        let system = max(0, used - apps - docs - junk)
        let slices = [StorageSliceData(key:"system",label:"System",bytes:system),
                      StorageSliceData(key:"applications",label:"Applications",bytes:apps),
                      StorageSliceData(key:"documents",label:"Documents",bytes:docs),
                      StorageSliceData(key:"junk",label:"Junk & Caches",bytes:junk),
                      StorageSliceData(key:"free",label:"Free",bytes:free)]
        return StorageInfo(totalGb: t/1_073_741_824, usedGb: used/1_073_741_824, freeGb: free/1_073_741_824,
                           usedPct: t > 0 ? used/t*100 : 0, slices: slices)
    }
}
