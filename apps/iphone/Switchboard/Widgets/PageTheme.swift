import SwiftUI
import UIKit

/// A page the agent made (the core's gateway/src/page.ts) in the phone's theme: SIS's colors as the
/// page's variables, dark as the app is (desktop's widgets/page-theme.ts does the same from its
/// own tokens).
enum PageTheme {
  /// The style a page keeps its theme in (THEME_ID in the core).
  private static let style = /<style id="switch-theme">[^<]*<\/style>/

  /// A page with the phone's theme in place of the one it carries; anything else as it is.
  static func themed(_ page: String) -> String {
    page.replacing(style, maxReplacements: 1) { _ in "<style id=\"switch-theme\">\(css)</style>" }
  }

  private static var css: String {
    let dark = UITraitCollection(userInterfaceStyle: .dark)
    func hex(_ color: Color) -> String {
      var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
      UIColor(color).resolvedColor(with: dark).getRed(&r, green: &g, blue: &b, alpha: &a)
      return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
    }
    let colors: [(String, Color)] =
      [
        ("bg", SIS.paper), ("line-1", SIS.rule), ("line-2", SIS.hair), ("ink", SIS.ink), ("ink2", SIS.ink2),
        ("ink3", SIS.ink3), ("go", SIS.Key.goTop), ("yellow", SIS.needs), ("orange", SIS.running), ("red", SIS.stopped),
      ] + SIS.series.enumerated().map { ("series-\($0.offset + 1)", $0.element) }
    let fonts = [
      "--font-sans:-apple-system, \"SF Pro Text\", \"Helvetica Neue\", sans-serif;",
      "--font-mono:ui-monospace, \"SF Mono\", Menlo, monospace;",
      "--font-sign:\"DIN Condensed\", \"DINCondensed-Bold\", sans-serif;",
    ]
    return ":root{color-scheme:dark;" + colors.map { "--color-\($0.0):\(hex($0.1));" }.joined() + fonts.joined() + "}"
  }
}
