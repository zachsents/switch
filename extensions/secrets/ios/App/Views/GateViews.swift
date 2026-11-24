import SwiftUI
import UIKit

/// Joining the vault: a name for this iPhone (and the core, if none is set), then the code to match
/// on the approving device while it waits.
struct EnrollView: View {
  let model: Model
  @State private var name = UIDevice.current.name
  @State private var core = Config.core
  @State private var problem: String?
  @State private var busy = false

  private var vault: Vault { model.vault }

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem { Problem(text: problem) }
      ScrollView {
        VStack(spacing: 0) {
          switch vault.phase {
          case .waiting: waiting
          case .revoked: revoked
          default: form
          }
        }
      }
    }
    .background(SIS.paper)
    .band("Secrets")
    .task(id: vault.phase) {
      while vault.phase == .waiting && !Task.isCancelled {
        await vault.sync()
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  @ViewBuilder private var form: some View {
    BoardSection(label: "This iPhone", first: true) {
      Rule()
      VStack(alignment: .leading, spacing: SIS.gap) {
        if !model.core.configured {
          TextField("ws://host:port", text: $core)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .inset()
        }
        TextField("Name", text: $name).inset()
        HStack {
          Spacer()
          if busy { Runner() }
          Button("Enroll") { Task { await enroll() } }
            .buttonStyle(KeyStyle(go: true))
            .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
        }
      }
      .padding(SIS.inset)
    }
  }

  @ViewBuilder private var waiting: some View {
    BoardSection(mark: AnyView(Hand(size: 13)), label: "Code", first: true) {
      Rule()
      HStack(spacing: 12) {
        Text(spaced(vault.cache.code)).font(SIS.number(SIS.Size.countdown)).foregroundStyle(SIS.ink).textSelection(.enabled)
        Spacer()
        Runner(size: SIS.markLarge)
      }
      .padding(SIS.inset)
      .overlay(alignment: .bottom) { Hairline() }
      Cell(label: "Name", value: name)
      HStack {
        Spacer()
        Button("Cancel") { Task { await vault.forget() } }.buttonStyle(KeyStyle())
      }
      .padding(SIS.inset)
    }
  }

  @ViewBuilder private var revoked: some View {
    BoardSection(mark: AnyView(Stop(size: 13)), label: "Revoked", first: true) {
      Rule()
      HStack {
        Spacer()
        Button("Forget this iPhone") { Task { await vault.forget() } }.buttonStyle(KeyStyle(go: true))
      }
      .padding(SIS.inset)
    }
  }

  private func spaced(_ code: String) -> String { "\(code.prefix(3)) \(code.dropFirst(3))" }

  private func enroll() async {
    busy = true
    defer { busy = false }
    if !model.core.configured {
      let given = core.trimmingCharacters(in: .whitespaces)
      Config.defaults.set(given, forKey: "core")
      model.core.forgetToken()
      model.core.configure(given)
      guard model.core.configured else { return problem = "That isn't a core address" }
      model.pair()
    }
    do {
      try await vault.enroll(name: name.trimmingCharacters(in: .whitespaces))
      problem = nil
      await vault.sync()
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// Locked: Face ID opens it.
struct LockView: View {
  let model: Model
  @State private var problem: String?
  @State private var tried = false

  var body: some View {
    VStack(spacing: 0) {
      if let problem { Problem(text: problem) }
      Spacer()
      Button {
        Task { await unlock() }
      } label: {
        Label("Unlock", systemImage: "faceid")
      }
      .buttonStyle(KeyStyle(go: true))
      Spacer()
    }
    .frame(maxWidth: .infinity)
    .background(SIS.paper)
    .band("Secrets")
    .task {
      guard !tried else { return }
      tried = true
      await unlock()
    }
  }

  private func unlock() async {
    do {
      try await model.vault.unlock()
      problem = nil
      await model.vault.sync()
    } catch {
      problem = error.localizedDescription
    }
  }
}
