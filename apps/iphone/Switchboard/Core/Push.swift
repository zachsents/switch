import UIKit
import UserNotifications

/// Notifications on this iPhone: it registers with APNs and reports where the core reaches it
/// (`iphone.reported`, with its Live Activities' tokens), so action items and the agent's asks
/// arrive away from any Mac. On the lock screen an item is answered (Approve, Decline, an option),
/// marked done or replied on; a tap opens its sheet. What's answered from a notification is kept
/// (Outbox) until the core has it. The badge is the open items' count, and notifications of closed
/// items go. From Switchboard's iPhone app (Core/Push.swift).
@MainActor
final class Push {
  static let shared = Push()

  private weak var phone: Phone?
  private var token: String?
  /// What was last reported, so it goes again only when it changes.
  private var reported: JSON?

  func start(_ phone: Phone) {
    self.phone = phone
    Task {
      let center = UNUserNotificationCenter.current()
      _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
      UIApplication.shared.registerForRemoteNotifications()
      await report(force: true)
    }
  }

  func registered(_ token: Data) {
    self.token = token.hex
    Task { await report(force: false) }
  }

  /// Back in front, or a token changed: iOS's say may have changed in Settings.
  func woke() {
    Task { await report(force: false) }
  }

  /// A new socket (a new pairing): the core hears of this phone afresh.
  func connected() {
    Task { await report(force: true) }
  }

  private func report(force: Bool) async {
    guard let phone else { return }
    let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    let say =
      switch status {
      case .notDetermined: "undecided"
      case .denied: "denied"
      default: "allowed"
      }
    var payload: [String: JSON] = [
      "device": .string(phone.device), "name": .string(UIDevice.current.name), "notifications": .string(say),
      "activities": .object(LiveActivities.shared.tokens.mapValues(JSON.string)),
    ]
    if let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String { payload["build"] = .string(build) }
    if let token, let topic = Bundle.main.bundleIdentifier {
      payload["apns"] = ["token": .string(token), "environment": .string(Self.environment), "topic": .string(topic)]
    }
    if let start = LiveActivities.shared.startToken { payload["pushToStart"] = .string(start) }
    let now = JSON.object(payload)
    guard force || now != reported else { return }
    reported = now
    phone.emit("iphone.reported", now)
  }

  /// Which APNs this build is signed for: the sandbox for a development build, else production.
  private static var environment: String {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
      let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .isoLatin1),
      let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>"),
      let profile = try? PropertyListSerialization.propertyList(from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil)
        as? [String: Any],
      let entitlements = profile["Entitlements"] as? [String: Any]
    else { return "production" }
    return entitlements["aps-environment"] as? String ?? "production"
  }

  // MARK: Tidying

  /// The open items as the brain has them: the badge is their count, and delivered notifications
  /// of items not among them go.
  func tidy(open: Set<String>) {
    Task {
      let center = UNUserNotificationCenter.current()
      try? await center.setBadgeCount(open.count)
      let closed = await center.deliveredNotifications().filter { n in
        guard let item = n.request.content.userInfo["item"] as? String else { return false }
        return !open.contains(item)
      }
      center.removeDeliveredNotifications(withIdentifiers: closed.map(\.request.identifier))
    }
  }

  /// A quiet push: an item closed, maybe while the app wasn't running.
  func quiet(_ info: JSON) async {
    let center = UNUserNotificationCenter.current()
    if let badge = info["aps"]["badge"].number { try? await center.setBadgeCount(Int(badge)) }
    guard let item = info["closed"].string else { return }
    let gone = await center.deliveredNotifications().filter { $0.request.content.userInfo["item"] as? String == item }
    center.removeDeliveredNotifications(withIdentifiers: gone.map(\.request.identifier))
  }

  /// A space's chat seen in the app: its unread-reply notifications go.
  func seen(_ space: String) {
    Task {
      let center = UNUserNotificationCenter.current()
      let read = await center.deliveredNotifications().filter {
        $0.request.content.categoryIdentifier == Categories.replyCategory && $0.request.content.userInfo["space"] as? String == space
      }
      if !read.isEmpty { center.removeDeliveredNotifications(withIdentifiers: read.map(\.request.identifier)) }
    }
  }

  // MARK: Answering

  /// What the user did with a notification.
  struct Response: Sendable {
    let action: String
    let typed: String
    let info: Data?

    nonisolated init(_ response: UNNotificationResponse) {
      let content = response.notification.request.content
      action = response.actionIdentifier
      typed = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      info = try? JSONSerialization.data(withJSONObject: content.userInfo)
    }
  }

  /// How long an answer may hold iOS's completion handler while the socket comes up.
  private static let answerWait = 8.0

  func respond(_ r: Response) async {
    let phone = Phone.shared
    let info = r.info.flatMap(JSON.parse) ?? .null
    let space = info["space"].string ?? HOME
    let id = UUID().uuidString
    switch r.action {
    case UNNotificationDismissActionIdentifier:
      return
    case UNNotificationDefaultActionIdentifier, Categories.add:
      if let pass = info["pass"].string { phone.passToAdd = pass }
      if let item = info["item"].string {
        phone.openItem(item, in: space)
        // An ask with a live view opens the view itself, as Switchboard's did.
        if info["portal"].bool == true { phone.portal = item } else { phone.asking = item }
      } else {
        phone.openSpace(space, at: info["seq"].number.map { Int($0) })
      }
      return
    case Categories.reply:
      guard !r.typed.isEmpty else { return }
      var said: [String: JSON] = ["space": .string(space), "text": .string(r.typed)]
      if let item = info["item"].string { said["item"] = .string(item) }
      phone.answer("message.post", .object(said), id: id)
    case Categories.done:
      guard let item = info["item"].string else { return }
      phone.answer("item.close", ["id": .string(item), "status": "done"], id: id)
    case Categories.approve, Categories.decline:
      guard let item = info["item"].string else { return }
      phone.answer("item.answer", ["id": .string(item), "approved": .bool(r.action == Categories.approve)], id: id)
    case let action where action.hasPrefix(Categories.choice):
      let item = info["item"].string
      let options = (item == nil ? info["ask"]["options"] : info["options"]).array.map(\.str)
      guard let i = Int(action.dropFirst(Categories.choice.count)), options.indices.contains(i) else { return }
      if let item {
        phone.answer("item.answer", ["id": .string(item), "choice": .string(options[i])], id: id)
      } else {
        phone.answer("message.post", ["space": .string(space), "text": .string(options[i])], id: id)
      }
    default:
      return
    }
    // Woken in the background for it: hold iOS's handler a moment so it can go now.
    let until = Date().addingTimeInterval(Self.answerWait)
    while Outbox.shared.has(id) && Date() < until {
      try? await Task.sleep(for: .milliseconds(250))
    }
  }
}

/// The app's delegate, for what iOS tells only a delegate: the push token, quiet pushes and responses.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    Task {
      let questions = await center.notificationCategories().filter { Categories.perQuestion($0.identifier) }
      center.setNotificationCategories(Categories.all.union(questions))
    }
    // Launched in the background (a notification's action, a quiet push) there may be no scene:
    // the socket starts here, so what's kept goes now.
    _ = Phone.shared
    Crashes.shared.start()
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Push.shared.registered(deviceToken)
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

  // These take iOS's completion handlers rather than being `async`: UIKit's handlers must be
  // called on the main thread, and an async delegate method returns on the concurrent pool.

  func application(
    _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    let info = (try? JSONSerialization.data(withJSONObject: userInfo)).flatMap(JSON.parse) ?? .null
    let done = Handler { completionHandler(.newData) }
    Task { @MainActor in
      await Push.shared.quiet(info)
      done.call()
    }
  }

  /// In front, the app shows what the notification would, so it stays quiet.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([])
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let r = Push.Response(response)
    let done = Handler(completionHandler)
    Task { @MainActor in
      await Push.shared.respond(r)
      done.call()
    }
  }
}

nonisolated private struct Handler: @unchecked Sendable {
  let call: () -> Void
  init(_ call: @escaping () -> Void) { self.call = call }
}

extension Data {
  /// Bytes as lowercase hex, as APNs' tokens are written.
  var hex: String { map { String(format: "%02x", $0) }.joined() }
}
