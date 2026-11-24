import SwiftUI

/// The core this iPhone reaches, this device in the vault, and leaving it.
struct SettingsView: View {
  let model: Model
  @State private var core = Config.core
  @State private var forgetting = false

  private var vault: Vault { model.vault }

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      ScrollView {
        VStack(spacing: 0) {
          BoardSection(label: "Core", first: true) {
            Rule()
            HStack(spacing: SIS.gap) {
              TextField("ws://host:port", text: $core)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .inset()
              Button("Save") {
                let given = core.trimmingCharacters(in: .whitespaces)
                Config.defaults.set(given, forKey: "core")
                model.core.forgetToken()
                model.core.configure(given)
                model.pair()
                Task { await vault.sync() }
              }
              .buttonStyle(KeyStyle())
              .disabled(core == Config.core)
            }
            .padding(SIS.inset)
          }
          BoardSection(label: "This iPhone") {
            Rule()
            Cell(label: "Device", value: vault.cache.device, mono: true)
            Cell(label: "Code", value: vault.cache.code, mono: true)
            Cell(label: "Key version", value: "\(vault.cache.keyVersion)", mono: true)
            HStack {
              Spacer()
              Button("Forget this iPhone", role: .destructive) { forgetting = true }.buttonStyle(KeyStyle())
            }
            .padding(SIS.inset)
          }
        }
      }
    }
    .background(SIS.paper)
    .band("Settings")
    .confirmationDialog("Forget this iPhone?", isPresented: $forgetting, titleVisibility: .visible) {
      Button("Forget", role: .destructive) { Task { await vault.forget() } }
    }
  }
}
