import UserNotifications

/// What a notification offers on the lock screen, shared by the app and its notification service.
/// The core names the category in the push: an action item's by its kind, `item` (a task: Done),
/// `item.approval` (Approve, Decline), `item.question` (made per item by the service when it has
/// options, `item.options.<id>`), `item.sealed` (nothing: a tap opens it, since the lock screen
/// can't take secure text); `ask` (the agent asking), `ask.options` (per question), `pass`, and
/// `reply` (an agent's reply left unread).
nonisolated enum Categories {
  static let reply = "reply"
  static let replyCategory = "reply"
  static let done = "done"
  static let approve = "approve"
  static let decline = "decline"
  static let add = "add"
  /// An option's action is this followed by its index.
  static let choice = "choice."
  static let optionsPrefix = "ask.options."
  static let itemOptionsPrefix = "item.options."

  static var all: Set<UNNotificationCategory> {
    [
      category("item", [action(done, "Done", "checkmark"), replying]),
      category(
        "item.approval",
        [action(approve, "Approve", "checkmark"), action(decline, "Decline", "xmark", locked: true), replying]),
      category("item.question", [replying]),
      category("item.sealed", []),
      category("ask", [replying]),
      category(replyCategory, [replying]),
      category("pass", [action(add, "Add to Wallet", "wallet.pass")]),
    ]
  }

  /// A question's own category, with its options as buttons: an ask's, or an item's.
  static func options(_ id: String, _ options: [String], prefix: String = optionsPrefix) -> UNNotificationCategory {
    let chosen = options.enumerated().map { action("\(choice)\($0.offset)", $0.element, nil) }
    return category(prefix + id, chosen + [replying])
  }

  /// Whether a category is one made per question.
  static func perQuestion(_ id: String) -> Bool {
    id.hasPrefix(optionsPrefix) || id.hasPrefix(itemOptionsPrefix)
  }

  private static var replying: UNNotificationAction {
    UNTextInputNotificationAction(
      identifier: reply, title: "Reply", options: [.authenticationRequired],
      icon: UNNotificationActionIcon(systemImageName: "bubble.left"), textInputButtonTitle: "Send",
      textInputPlaceholder: "Reply")
  }

  /// `locked`: it works without unlocking (a Decline sends nothing out).
  private static func action(_ id: String, _ title: String, _ symbol: String?, locked: Bool = false) -> UNNotificationAction {
    UNNotificationAction(
      identifier: id, title: title, options: locked ? [] : [.authenticationRequired],
      icon: symbol.map { UNNotificationActionIcon(systemImageName: $0) })
  }

  private static func category(_ id: String, _ actions: [UNNotificationAction]) -> UNNotificationCategory {
    UNNotificationCategory(identifier: id, actions: actions, intentIdentifiers: [], options: [])
  }
}
