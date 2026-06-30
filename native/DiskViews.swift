import SwiftUI

// MARK: - Shared dark-theme components ----------------------------------------------------------
// Ghost action button (Quit / Reveal / Trash / Uninstall) — gold or warm-red, always readable on dark.
struct GhostButton: View {
    let title: String; var danger = false; let action: () -> Void
    @State private var hover = false
    var body: some View {
        let tint: Color = danger ? .rgDanger : .rgGold
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundColor(tint)
                .padding(.horizontal, 11).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(tint.opacity(hover ? 0.24 : 0.13)))
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(tint.opacity(0.4), lineWidth: 1))
        }
        .buttonStyle(.plain).onHover { hover = $0 }
    }
}
// Primary call-to-action — gold fill, dark ink text.
struct PrimaryButton: View {
    let title: String; let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundColor(.rgInk)
                .frame(maxWidth: .infinity).padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 11).fill(Color.rgGold.opacity(hover ? 0.9 : 1)))
        }
        .buttonStyle(.plain).onHover { hover = $0 }
    }
}
private struct Header: View {
    let title: String; let subtitle: String; let busy: Bool; let refresh: () -> Void
    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 16, weight: .bold)).foregroundColor(.rgBone)
                Text(subtitle).font(.system(size: 11)).foregroundColor(.rgMute)
            }
            Spacer()
            if busy { ProgressView().controlSize(.small).tint(.rgGold) }
            else { Button(action: refresh) { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).foregroundColor(.rgGold) }
        }
    }
}
private func emptyNote(_ s: String) -> some View {
    Text(s).font(.system(size: 12)).foregroundColor(.rgMute).frame(maxWidth: .infinity, alignment: .center).padding(.top, 30)
}
// Row card shell — the panel-on-charcoal look shared by every list row.
private func rowCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 10) { content() }
        .padding(.vertical, 8).padding(.horizontal, 11)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color.rgPanel))
}
// Every tab fills the window with the charcoal background + forces dark so system colors resolve light.
private func tabShell<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    content()
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.rgBg)
        .preferredColorScheme(.dark)
}

// MARK: - Junk ----------------------------------------------------------------------------------
struct JunkView: View {
    @ObservedObject var e: JunkEngine
    var body: some View {
        tabShell {
            VStack(alignment: .leading, spacing: 12) {
                Header(title: "Clean Up Junk", subtitle: "Caches, logs & Trash — moved to the Trash, recoverable", busy: e.busy, refresh: e.scan)
                if let f = e.lastFreed { Text("Freed \(fmtSize(f))").font(.system(size: 12, weight: .semibold)).foregroundColor(.rgGold) }
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(e.cats) { c in
                            rowCard {
                                Image(systemName: c.selected ? "checkmark.square.fill" : "square")
                                    .foregroundColor(c.selected ? .rgGold : .rgMute)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(c.label).font(.system(size: 13, weight: .medium)).foregroundColor(.rgBone)
                                    Text(c.detail).font(.system(size: 10)).foregroundColor(.rgMute)
                                }
                                Spacer()
                                Text(fmtSize(c.bytes)).font(.system(size: 12, design: .rounded)).foregroundColor(.rgMute)
                            }
                            .contentShape(Rectangle()).onTapGesture { e.toggle(c.id) }
                        }
                    }
                }
                PrimaryButton(title: "Clean selected") { e.clean() }
                    .disabled(e.busy || !e.cats.contains { $0.selected && $0.bytes > 0 })
                    .opacity(e.busy || !e.cats.contains { $0.selected && $0.bytes > 0 } ? 0.5 : 1)
            }
        }.onAppear { if e.cats.isEmpty { e.scan() } }
    }
}

// MARK: - Large files -------------------------------------------------------------------------
struct LargeFilesView: View {
    @ObservedObject var e: LargeFilesEngine
    var body: some View {
        tabShell {
            VStack(alignment: .leading, spacing: 12) {
                Header(title: "Large & Old Files", subtitle: "100 MB+, untouched 90+ days · Downloads, Movies, Documents, Desktop", busy: e.busy, refresh: { e.scan() })
                if !e.busy && e.files.isEmpty { emptyNote("No large, unused files found.") }
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(e.files) { f in
                            rowCard {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(f.name).font(.system(size: 13, weight: .medium)).foregroundColor(.rgBone).lineLimit(1)
                                    Text("\(f.category) · \(f.ageDays == Int.max ? "never opened" : "\(f.ageDays)d ago")").font(.system(size: 10)).foregroundColor(.rgMute)
                                }
                                Spacer()
                                Text(fmtSize(f.bytes)).font(.system(size: 12, design: .rounded)).foregroundColor(.rgMute)
                                GhostButton(title: "Reveal") { e.reveal(f) }
                                GhostButton(title: "Trash", danger: true) { e.trash(f) }
                            }
                        }
                    }
                }
            }
        }.onAppear { if e.files.isEmpty { e.scan() } }
    }
}

// MARK: - Apps ----------------------------------------------------------------------------------
struct AppsView: View {
    @ObservedObject var e: AppsEngine
    var body: some View {
        tabShell {
            VStack(alignment: .leading, spacing: 12) {
                Header(title: "Uninstall Apps", subtitle: "Removes the app + its leftover files to the Trash", busy: e.busy, refresh: e.scan)
                if !e.busy && e.apps.isEmpty { emptyNote("Scanning /Applications…") }
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(e.apps) { a in
                            rowCard {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(a.name).font(.system(size: 13, weight: .medium)).foregroundColor(.rgBone).lineLimit(1)
                                    Text(a.detail).font(.system(size: 10)).foregroundColor(.rgMute)
                                }
                                Spacer()
                                GhostButton(title: "Uninstall", danger: true) { e.uninstall(a) }
                            }
                        }
                    }
                }
            }
        }.onAppear { if e.apps.isEmpty { e.scan() } }
    }
}

// MARK: - Login items ---------------------------------------------------------------------------
struct LoginView: View {
    @ObservedObject var e: LoginItemsEngine
    var body: some View {
        tabShell {
            VStack(alignment: .leading, spacing: 12) {
                Header(title: "Login Items", subtitle: "Apps that open at startup — stop one to speed up boot", busy: e.busy, refresh: e.scan)
                if !e.busy && e.items.isEmpty { emptyNote("No login items (or System Events permission needed).") }
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(e.items) { it in
                            rowCard {
                                Text(it.name).font(.system(size: 13, weight: .medium)).foregroundColor(.rgBone).lineLimit(1)
                                if it.hidden {
                                    Text("hidden").font(.system(size: 9)).foregroundColor(.rgMute)
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.rgPanel2))
                                }
                                Spacer()
                                GhostButton(title: "Stop at login", danger: true) { e.remove(it) }
                            }
                        }
                    }
                }
            }
        }.onAppear { if e.items.isEmpty { e.scan() } }
    }
}

// MARK: - Storage -------------------------------------------------------------------------------
struct StorageView: View {
    @ObservedObject var e: StorageEngine
    var body: some View {
        tabShell {
            VStack(alignment: .leading, spacing: 14) {
                Header(title: "Disk Storage", subtitle: "What's filling your drive", busy: e.busy, refresh: e.scan)
                Text(String(format: "%.0f GB used of %.0f GB  ·  %.0f GB free", e.info.usedGb, e.info.totalGb, e.info.freeGb))
                    .font(.system(size: 12, design: .rounded)).foregroundColor(.rgMute)
                GeometryReader { g in
                    HStack(spacing: 1) {
                        ForEach(e.info.slices.filter { $0.bytes > 0 }, id: \.key) { s in
                            Rectangle().fill(StorageEngine.colors[s.key] ?? .gray)
                                .frame(width: max(0, g.size.width * CGFloat(e.info.totalGb > 0 ? (s.bytes/1_073_741_824)/e.info.totalGb : 0)))
                        }
                    }.clipShape(RoundedRectangle(cornerRadius: 8))
                }.frame(height: 26)
                VStack(spacing: 7) {
                    ForEach(e.info.slices, id: \.key) { s in
                        HStack {
                            RoundedRectangle(cornerRadius: 3).fill(StorageEngine.colors[s.key] ?? .gray).frame(width: 12, height: 12)
                            Text(s.label).font(.system(size: 12)).foregroundColor(.rgBone)
                            Spacer()
                            Text(fmtSize(s.bytes)).font(.system(size: 12, design: .rounded)).foregroundColor(.rgMute)
                        }
                    }
                }
                Spacer()
            }
        }.onAppear { if e.info.totalGb == 0 { e.scan() } }
    }
}
