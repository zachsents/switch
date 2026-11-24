import AuthenticationServices
import SwiftUI

/// The vault in this extension's process: it shares the app's key (the keychain group) and blobs
/// (the app group), and opens on its own Face ID. It stays open only briefly.
@MainActor let vault = Vault(core: Core(app: "secrets"))
@MainActor var openedAt: Date?

/// AutoFill: logins for a page or app, filled with a password or a one-time code.
final class CredentialProviderViewController: ASCredentialProviderViewController {
  /// How long a Face ID here fills without asking again.
  static let grace: TimeInterval = 120

  private var host: UIHostingController<PickerView>?

  // MARK: Lists

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    show(.password, serviceIdentifiers)
  }

  override func prepareOneTimeCodeCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    show(.code, serviceIdentifiers)
  }

  // MARK: One chosen above the keyboard

  override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) {
    guard vault.phase == .open, let at = openedAt, Date().timeIntervalSince(at) < Self.grace,
      let item = vault.item(credentialRequest.credentialIdentity.recordIdentifier ?? "")
    else {
      return cancel(.userInteractionRequired)
    }
    complete(item, credentialRequest.type == .oneTimeCode ? .code : .password)
  }

  override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) {
    let id = credentialRequest.credentialIdentity.recordIdentifier ?? ""
    let mode: PickerView.Mode = credentialRequest.type == .oneTimeCode ? .code : .password
    Task {
      do {
        try await unlock()
        guard let item = vault.item(id) else { return show(mode, []) }
        complete(item, mode)
      } catch {
        cancel(.userCanceled)
      }
    }
  }

  override func prepareInterfaceForExtensionConfiguration() {
    Task {
      if vault.phase == .locked { try? await unlock() }
      extensionContext.completeExtensionConfigurationRequest()
    }
  }

  // MARK: Parts

  private func show(_ mode: PickerView.Mode, _ services: [ASCredentialServiceIdentifier]) {
    let view = PickerView(mode: mode, services: services, unlock: { [weak self] in try await self?.unlock() }) { [weak self] item in
      self?.complete(item, mode)
    } cancel: { [weak self] in
      self?.cancel(.userCanceled)
    }
    if let host {
      host.rootView = view
      return
    }
    let made = UIHostingController(rootView: view)
    made.overrideUserInterfaceStyle = .dark
    addChild(made)
    made.view.frame = self.view.bounds
    made.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    self.view.addSubview(made.view)
    made.didMove(toParent: self)
    host = made
  }

  private func unlock() async throws {
    if vault.phase != .open { try await vault.unlock() }
    openedAt = Date()
    Task { await vault.sync() }
  }

  private func complete(_ item: Item, _ mode: PickerView.Mode) {
    switch mode {
    case .password:
      vault.used(item, "password", "autofill")
      extensionContext.completeRequest(withSelectedCredential: ASPasswordCredential(user: item.username, password: item.password))
    case .code:
      guard let totp = TOTP(item.totp) else { return cancel(.credentialIdentityNotFound) }
      vault.used(item, "totp", "autofill")
      extensionContext.completeOneTimeCodeRequest(using: ASOneTimeCodeCredential(code: totp.code()))
    }
  }

  private func cancel(_ code: ASExtensionError.Code) {
    extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
  }
}
