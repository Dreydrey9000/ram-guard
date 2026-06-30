// RAM Guard native — safety + parser self-test (Trash-only proof, allowlist, pure parsers).
// Run:  d=/tmp/rgtest_build; mkdir -p $d; cp selftest.swift $d/main.swift; \
//       swiftc Common.swift DiskEngines.swift $d/main.swift -o /tmp/rgtest && /tmp/rgtest
//       (swiftc needs the top-level test file named main.swift in a multi-file build)
// Must print "ALL DISK CHECKS PASSED" before shipping any change to the disk engines.

import Foundation

var failures = 0
func check(_ cond: Bool, _ msg: String) {
    if cond { print("  ok  \(msg)") } else { print("  FAIL \(msg)"); failures += 1 }
}

print("== 1. TRASH-ONLY: a cleaned file must land in ~/.Trash (recoverable), never hard-deleted ==")
let tag = "ramguard_verify_\(getpid())"
let tmpDir = NSTemporaryDirectory() + "\(tag)_dir"
try? FileManager.default.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)
let victim = tmpDir + "/\(tag).txt"
FileManager.default.createFile(atPath: victim, contents: Data("delete me".utf8))
check(FileManager.default.fileExists(atPath: victim), "victim file created")
let moved = Trash.move(victim)
check(moved, "Trash.move returned true")
check(!FileManager.default.fileExists(atPath: victim), "source is GONE (moved, not left behind)")
let trashDir = Paths.j(".Trash")
let trashed = (try? FileManager.default.contentsOfDirectory(atPath: trashDir))?.filter { $0.contains(tag) } ?? []
check(!trashed.isEmpty, "file is RECOVERABLE in ~/.Trash (\(trashed.first ?? "none"))")
// cleanup our test artifact + dir
for t in trashed { try? FileManager.default.removeItem(atPath: trashDir + "/" + t) }
try? FileManager.default.removeItem(atPath: tmpDir)

print("== 2. ALLOWLIST: only paths under an allowed root may ever be trashed ==")
check(Paths.isUnder("/etc/passwd", roots: JunkEngine.allowedRoots) == false, "rejects /etc/passwd")
check(Paths.isUnder(Paths.j("Library","Caches") + "/foo", roots: JunkEngine.allowedRoots) == true, "accepts ~/Library/Caches/foo")
check(Paths.isUnder("/Applications-evil", roots: ["/Applications"]) == false, "segment boundary: /Applications-evil rejected")
check(Paths.isUnder("/Applications", roots: ["/Applications"]) == true, "accepts the root itself")
check(LargeFilesEngine().validTarget("/etc/hosts") == false, "large-files validTarget rejects /etc/hosts")
// symlink escape (Sakana fix): a symlink inside an allowed-looking root that points OUT must be rejected
let symDir = NSTemporaryDirectory() + "\(tag)_sym"
try? FileManager.default.createDirectory(atPath: symDir, withIntermediateDirectories: true)
let escape = symDir + "/escape"
try? FileManager.default.createSymbolicLink(atPath: escape, withDestinationPath: "/etc")
check(Paths.isSymlink(escape) == true, "isSymlink detects a symlink")
check(Paths.isUnder(escape + "/passwd", roots: [symDir]) == false, "isUnder rejects a path through an escaping symlink")
try? FileManager.default.removeItem(atPath: symDir)

print("== 3. PARSERS (pinned against fixtures) ==")
check(parseDuK("12345\t/x\n67\t/y\n") == (12345.0 + 67) * 1024, "parseDuK sums kB columns")
let st = LargeFilesEngine.parseStat("1700000000|2048|/a/b.txt")
check(st["/a/b.txt"]?.bytes == 2048 && st["/a/b.txt"]?.atimeMs == 1_700_000_000_000, "parseStat atime+size")
check(LargeFilesEngine.mdlsDateToMs("2024-01-15 10:30:00 +0000") > 0, "mdlsDateToMs parses a real date")
check(LargeFilesEngine.mdlsDateToMs("(null)") == 0, "mdlsDateToMs (null) -> 0")
let md = LargeFilesEngine.parseMdls("kMDItemLastUsedDate = 2024-01-15 10:30:00 +0000\nkMDItemLastUsedDate = (null)\n", count: 2)
check(md.count == 2 && (md[0] ?? 0) > 0 && (md[1] ?? 0) == 0, "parseMdls zips dates in order")
check(AppsEngine.parseBundleId("kMDItemCFBundleIdentifier = \"com.apple.Safari\"") == "com.apple.Safari", "parseBundleId")
let li = LoginItemsEngine.parse("CapCut, Raycast\nfalse, true")
check(li.count == 2 && li[1].name == "Raycast" && li[1].hidden == true, "parseLoginItems names+hidden")
let df = StorageEngine.parseDf("Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 100 60 40 60% 1 1 1% /System/Volumes/Data")
check(df.0 == 100*1024 && df.1 == 60*1024 && df.2 == 40*1024, "parseDf total/used/free")
let b = StorageEngine.buckets(total: 100, used: 60, free: 40, apps: 10, docs: 10, junk: 5)
let sys = b.slices.first { $0.key == "system" }!.bytes
check(sys == 35, "buckets: system = used - apps - docs - junk (60-10-10-5=35)")
check(abs(b.usedPct - 60) < 0.001, "buckets usedPct")

print(failures == 0 ? "\nALL DISK CHECKS PASSED" : "\n\(failures) CHECK(S) FAILED")
exit(failures == 0 ? 0 : 1)
