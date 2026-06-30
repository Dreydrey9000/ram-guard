import Foundation
import AppKit

// MARK: - Shared shell (background-read + deadline so a wedged tool can't strand a worker thread)
final class OutputBox { var data = Data() }   // ponytail: carries run output across the read thread

@discardableResult
func shell(_ path: String, _ args: [String], timeout: TimeInterval = 6) -> String {
    let proc = Process(); proc.executableURL = URL(fileURLWithPath: path); proc.arguments = args
    let pipe = Pipe(); proc.standardOutput = pipe; proc.standardError = Pipe()
    do { try proc.run() } catch { return "" }
    let handle = pipe.fileHandleForReading
    let box = OutputBox(); let sem = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .utility).async { box.data = handle.readDataToEndOfFile(); sem.signal() }
    if sem.wait(timeout: .now() + timeout) == .timedOut {
        proc.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { if proc.isRunning { kill(proc.processIdentifier, SIGKILL) } }
        return ""
    }
    proc.waitUntilExit()
    return String(data: box.data, encoding: .utf8) ?? ""
}

// MARK: - Trash (the ONLY deletion path — native, recoverable, NEVER rm/unlink)
enum Trash {
    // FileManager.trashItem moves to ~/.Trash with put-back metadata + collision naming, handles
    // cross-volume, and is recoverable. Replaces the whole Electron osascript+rename+EXDEV dance.
    @discardableResult
    static func move(_ path: String) -> Bool {
        do { try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil); return true }
        catch {
            FileHandle.standardError.write(Data("RAMGuard: trash \(path) failed: \(error.localizedDescription)\n".utf8))
            return false
        }
    }
    // Reclaiming Trash space is the one thing trashItem can't do (it's already there). Ask Finder.
    // ponytail: needs Automation permission (macOS prompts once); the junk view re-measures before/after
    // and credits only bytes that actually left, so a denied permission just frees nothing — never a lie.
    static func empty() { _ = shell("/usr/bin/osascript", ["-e", "tell application \"Finder\" to empty the trash"], timeout: 8) }
}

// MARK: - Path allowlist (no arbitrary/user path ever reaches a Trash move)
enum Paths {
    static let home = NSHomeDirectory()
    static func j(_ parts: String...) -> String { ([home] + parts).joined(separator: "/").replacingOccurrences(of: "//", with: "/") }
    static func exists(_ p: String) -> Bool { FileManager.default.fileExists(atPath: p) }
    static func isDir(_ p: String) -> Bool { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: p, isDirectory: &d) && d.boolValue }

    // True only when `target` is absolute and sits at/under one of `roots` (segment boundary, so
    // /a-b never counts as under /a). The gate the TS engines call isUnderAllowedRoot/isUnder.
    static func isUnder(_ target: String, roots: [String]) -> Bool {
        guard target.hasPrefix("/") else { return false }
        // Resolve symlinks + .. on BOTH sides so an intermediate symlink can't smuggle a path OUT
        // of the allowlist (Sakana: plain string-prefix containment was unsound).
        let t = (target as NSString).resolvingSymlinksInPath
        return roots.contains { root in
            let r = (root as NSString).resolvingSymlinksInPath
            return t == r || t.hasPrefix(r + "/")
        }
    }
    // lstat-based (does NOT follow): true if the path itself is a symlink. We never trash a symlink
    // in the cache cleaner — skip it rather than risk following a link out of the allowlist.
    static func isSymlink(_ p: String) -> Bool {
        (try? FileManager.default.attributesOfItem(atPath: p))?[.type] as? FileAttributeType == .typeSymbolicLink
    }
    // Immediate children of a dir, [] on any error (a permission-blocked root degrades, never throws).
    static func contents(_ dir: String) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).map { dir + "/" + $0 }
    }
}

// MARK: - du -sk over a fixed allowlist -> bytes (the shared sizing primitive)
func duBytes(_ dirs: [String], timeout: TimeInterval = 6) -> Double {
    let existing = dirs.filter { Paths.exists($0) }
    guard !existing.isEmpty else { return 0 }
    return parseDuK(shell("/usr/bin/du", ["-sk"] + existing, timeout: timeout))
}
// "<kilobytes>\t<path>" per line; sum the kB column, ignore non-numeric lines (stderr leaks). -> bytes.
func parseDuK(_ out: String) -> Double {
    var kb = 0.0
    for line in out.split(separator: "\n") {
        let t = line.trimmingCharacters(in: .whitespaces)
        if let n = t.split(separator: "\t").first ?? t.split(separator: " ").first, let v = Double(n) { kb += v }
    }
    return kb * 1024
}

// MARK: - confirm gate (every destructive action passes through here, on the main thread)
@MainActor
func confirmDestructive(_ title: String, _ detail: String, okTitle: String = "Move to Trash") -> Bool {
    let a = NSAlert(); a.messageText = title; a.informativeText = detail; a.alertStyle = .warning
    a.addButton(withTitle: okTitle); a.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    return a.runModal() == .alertFirstButtonReturn
}

// MARK: - byte formatting
func fmtMB(_ bytes: Double) -> String { String(format: "%.0f MB", bytes / 1_048_576) }
func fmtGB(_ bytes: Double) -> String { String(format: "%.1f GB", bytes / 1_073_741_824) }
func fmtSize(_ bytes: Double) -> String { bytes >= 1_073_741_824 ? fmtGB(bytes) : fmtMB(bytes) }
