@preconcurrency import UserNotifications

/// Gives a question's notification its options as buttons: iOS knows a notification's actions only
/// by its category, so each question with options (the agent's ask, or an action item's) gets one
/// of its own, registered as it arrives.
final class NotificationService: UNNotificationServiceExtension {
  /// Questions' categories kept besides the newest, so older ones on the lock screen keep buttons.
  private static let kept = 12

  override func didReceive(
    _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let info = request.content.userInfo
    let ask = info["ask"] as? [String: Any]
    let item = info["item"] as? String
    let options = (ask?["options"] ?? info["options"]) as? [String] ?? []
    let id = (ask?["id"] as? String) ?? item
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent, let id, !options.isEmpty
    else { return contentHandler(request.content) }
    let mine = Categories.options(id, options, prefix: ask == nil ? Categories.itemOptionsPrefix : Categories.optionsPrefix)
    let center = UNUserNotificationCenter.current()
    center.getNotificationCategories { existing in
      let questions = existing.filter { Categories.perQuestion($0.identifier) && $0.identifier != mine.identifier }
      let latest = questions.sorted { $0.identifier > $1.identifier }.prefix(Self.kept)
      center.setNotificationCategories(Categories.all.union(latest).union([mine]))
      center.getNotificationCategories { _ in
        content.categoryIdentifier = mine.identifier
        contentHandler(content)
      }
    }
  }
}
