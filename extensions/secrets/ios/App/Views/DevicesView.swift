import SwiftUI

/// The vault's devices and extensions: those waiting, approved here by matching their code, and
/// those in, each of which can be revoked.
struct DevicesView: View {
  let model: Model
  @State private var problem: String?
  @State private var approving: Member?
  @State private var revoking: Member?

  private var vault: Vault { model.vault }

  var body: some View {
    let all = vault.devices + vault.extensions
    let pending = all.filter(\.pending)
    let devices = vault.devices.filter(\.active)
    let extensions = vault.extensions.filter(\.active)
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem { Problem(text: problem) }
      ScrollView {
        LazyVStack(spacing: 0) {
          if !pending.isEmpty {
            BoardSection(mark: AnyView(Hand(size: 13)), label: "Waiting", count: pending.count, first: true) {
              Rule()
              ForEach(pending) { m in
                RowButton(action: { approving = m }) {
                  Text(m.name).lineLimit(1)
                  Spacer(minLength: 8)
                  Figure(m.code)
                }
              }
            }
          }
          BoardSection(label: "Devices", count: devices.count, first: pending.isEmpty) {
            Rule()
            ForEach(devices) { m in
              RowButton(action: { if m.id != vault.cache.device { revoking = m } }) {
                Image(systemName: m.kind == "iphone" ? "iphone" : "laptopcomputer").foregroundStyle(SIS.ink2).frame(width: 20)
                Text(m.name).lineLimit(1)
                Spacer(minLength: 8)
                if m.id == vault.cache.device { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(SIS.ink3) }
              }
            }
          }
          if !extensions.isEmpty {
            BoardSection(label: "Extensions", count: extensions.count) {
              Rule()
              ForEach(extensions) { m in
                RowButton(action: { revoking = m }) {
                  Text(m.name).lineLimit(1)
                  Spacer(minLength: 8)
                }
              }
            }
          }
        }
      }
      .refreshable { await vault.sync() }
    }
    .background(SIS.paper)
    .band("Devices")
    .confirmationDialog(
      "Approve \(approving?.name ?? "")?", isPresented: Binding(get: { approving != nil }, set: { if !$0 { approving = nil } }),
      titleVisibility: .visible, presenting: approving
    ) { m in
      Button("Approve") { Task { await act("Approve \(m.name)") { try await vault.approve(m) } } }
      Button("Deny", role: .destructive) { Task { await act("Deny \(m.name)") { try await vault.revoke(m) } } }
      Button("Cancel", role: .cancel) {}
    } message: { m in
      Text(m.code)
    }
    .confirmationDialog(
      "Revoke \(revoking?.name ?? "")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
      titleVisibility: .visible, presenting: revoking
    ) { m in
      Button("Revoke", role: .destructive) { Task { await act("Revoke \(m.name)") { try await vault.revoke(m) } } }
      Button("Cancel", role: .cancel) {}
    }
  }

  private func act(_ reason: String, _ work: () async throws -> Void) async {
    guard await model.confirm(reason) else { return }
    do {
      try await work()
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }
}
