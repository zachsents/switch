import SwiftUI

/// How Switch's apps look (Switchboard's Look/SIS.swift, kept the same): SIS, the Switchboard Interface Standard, rev D (the
/// mockups' sis.css and marks.js, Nov 13): rev C's grid, lines and keys,
/// with every workspace's line in its own ink and covers printed in it. Every
/// color, typeface, size, line, radius and shadow a widget draws with is
/// here and nowhere else, so another direction is an edit to this file. The
/// parts (Parts.swift) and every component read it.
///
/// A grid, not cards: one black band across the top of a screen, then
/// sections full-bleed, cells butting together and sharing their lines,
/// which run on a road-sign scale (a hairline inside a cell, a rule
/// between cells, a heavy rule between sections). Dark cockpit: at rest
/// it's ink on paper, and color lights only what needs the person
/// (yellow), what stopped (red) and the one live signal (orange). Done is
/// ink, up is grey, off is a ring. Green is the one key that sends. Keys
/// are raised and lit from above, sinking a point when pressed; the box a
/// person types in is inset. Two shadows: raised keys, and what floats.
/// Black: the app keeps the dark appearance, as the house style is.
///
/// Nonisolated, like Theme: SwiftUI resolves colors on its render thread.
nonisolated enum SIS {
  // MARK: Paper and ink

  /// Behind the page.
  static let desk = color(day: 0xDCDCDC, night: 0x000000)
  static let page = color(day: 0xF0F0F0, night: 0x000000)
  /// Cells, tiles, fields.
  static let paper = color(day: 0xFFFFFF, night: 0x0D0D0D)
  static let ink = color(day: 0x0A0A0A, night: 0xEDEDED)
  static let ink2 = color(day: 0x555555, night: 0xA3A3A3)
  static let ink3 = color(day: 0x8E8E8E, night: 0x6B6B6B)
  /// The band across the top of a screen (Unigrid): black in both
  /// appearances, with its own ink.
  static let band = color(day: 0x0A0A0A, night: 0x000000)
  static let bandInk = Color.white
  static let bandInk2 = color(day: 0x9A9A9A, night: 0x7A7A7A)
  /// A cell that stands out.
  static let wash = color(day: 0xF4F4F4, night: 0x161616)
  /// What's selected.
  static let selected = color(day: 0xEDEDED, night: 0x1E1E1E)
  static let bubble = color(day: 0xECECEC, night: 0x1F1F1F)

  // MARK: Lines, a road-sign scale

  /// Inside a cell: between rows, splits.
  static let hair = color(day: 0xC4C4C4, night: 0x333333)
  static let hairWidth: CGFloat = 0.5
  /// Between cells, and round a widget on its own.
  static let rule = color(day: 0xC4C4C4, night: 0x333333)
  static let line: CGFloat = 1
  /// Between sections.
  static let heavy = color(day: 0x0A0A0A, night: 0x8A8A8A)
  static let heavyWidth: CGFloat = 2

  // MARK: State: lit only when it matters (marks in Parts.swift)

  static let needs = color(day: 0xFFC000, night: 0xFFC000)
  /// Running, and whatever is live: a ticking colon, where you are on a route.
  static let running = color(day: 0xF26419, night: 0xF26419)
  static let stopped = color(day: 0xD42A1F, night: 0xD42A1F)
  /// Done is ink, up is grey, off is a ring in ink3.
  static let done = ink
  static let up = ink2
  static let off = ink3
  /// A glyph on each mark.
  static let onMark = Color.white
  static let onDone = paper

  // MARK: Inks: one per line of spaces

  /// A space's ink from its hexes, on paper and lifted for the dark ("#9C5E31", "#B9794A").
  static func ink(day: String?, night: String?) -> Color? {
    func value(_ hex: String?) -> UInt32? {
      guard let hex = hex?.trimmingCharacters(in: .whitespaces), hex.hasPrefix("#"), hex.count == 7 else { return nil }
      return UInt32(hex.dropFirst(), radix: 16)
    }
    guard let day = value(day) else { return nil }
    return color(day: day, night: value(night) ?? day)
  }

  /// The user's bubble in Home, which has no ink.
  static let own = color(day: 0x4A4A4A, night: 0x3A3A3A)

  // MARK: Keys: raised, lit from above (Braun)

  enum Key {
    static let top = color(day: 0xFFFFFF, night: 0x262626)
    static let bottom = color(day: 0xF0F0F0, night: 0x1B1B1B)
    static let border = color(day: 0x8C8C8C, night: 0x3C3C3C)
    /// The light along its top and left edges, and the shade along the others.
    static let light = color(day: 0xFFFFFF, night: 0x3A3A3A)
    static let shade = color(day: 0xD6D6D6, night: 0x0A0A0A)
    /// The edge it stands on.
    static let edge = color(day: 0xA6A6A6, night: 0x000000)
    static let pressed = color(day: 0xEAEAEA, night: 0x161616)
    /// The key that sends: green, and nothing else is.
    static let goTop = color(day: 0x0A8C58, night: 0x0B8A57)
    static let goBottom = color(day: 0x00744A, night: 0x00744A)
    static let goBorder = color(day: 0x004F37, night: 0x00513A)
    static let goEdge = color(day: 0x003A28, night: 0x000000)
    static let goHint = Color.white.opacity(0.66)
  }

  /// The box a person types in: inset, its shade inside its top edge.
  enum Field {
    static let fill = color(day: 0xFFFFFF, night: 0x070707)
    static let border = color(day: 0x9C9C9C, night: 0x333333)
    static let focused = color(day: 0x4A4A4A, night: 0x6B6B6B)
    static let shade = color(day: 0x000000, night: 0x000000, alpha: (0.13, 0.8))
  }

  /// A checkbox: a small raised key, ink when on.
  enum Box {
    static let top = color(day: 0xFFFFFF, night: 0x262626)
    static let bottom = color(day: 0xEEEEEE, night: 0x1A1A1A)
    static let border = color(day: 0x8E8E8E, night: 0x454545)
  }

  // MARK: Type: native faces only, tabular figures throughout

  /// Workspace names, and nothing else: DIN Condensed, in capitals.
  static func sign(_ size: CGFloat) -> Font { .custom("DINCondensed-Bold", size: size, relativeTo: .headline) }
  /// Figures (prices, times, counts, temperatures): DIN Alternate. Live
  /// ones are the same face, only bigger, and set a little tighter
  /// (`liveTracking`).
  static func number(_ size: CGFloat) -> Font { .custom("DINAlternate-Bold", size: size, relativeTo: .title).monospacedDigit() }
  /// Words: SF Pro, at the person's text size (`scale`).
  static func text(_ size: CGFloat, weight: Font.Weight = .regular) -> Font { .system(size: size * scale, weight: weight).monospacedDigit() }
  /// Data (times, counts, codes): SF Mono, at the person's text size.
  static func data(_ size: CGFloat = Size.data, weight: Font.Weight = .regular) -> Font { .system(size: size * scale, weight: weight, design: .monospaced) }
  /// How the person's text size (Dynamic Type) scales SF's sizes here: 1
  /// at the system's own (Large), as the DIN faces scale on their own
  /// (`relativeTo`), so words, names and figures grow together and the
  /// grid's lines still line up. The app sets it from the environment
  /// before it draws (`TextSize`), and draws afresh when it changes; a
  /// column sized for words (a workspace's time) is as wide times this too.
  nonisolated(unsafe) static var scale: CGFloat = 1
  /// A live figure's letter spacing, per point of size.
  static let liveTracking: CGFloat = -0.01
  /// A sign's letter spacing, per point of size.
  static let signTracking: CGFloat = 0.05
  /// A key hint's letter spacing, per point of size.
  static let hintTracking: CGFloat = 0.04

  /// The sizes, in points (the phone's: sheet 06).
  enum Size {
    static let body: CGFloat = 15
    static let caption: CGFloat = 12.5
    static let control: CGFloat = 14
    static let controlSmall: CGFloat = 12.5
    /// A label over a value, a period's name.
    static let label: CGFloat = 11
    static let heading: CGFloat = 14
    static let data: CGFloat = 11
    /// A row's figure at its right (a count, a clock).
    static let meta: CGFloat = 12
    static let readout: CGFloat = 24
    static let stub: CGFloat = 20
    static let route: CGFloat = 15
    static let routeName: CGFloat = 14
    static let term: CGFloat = 72
    static let title: CGFloat = 26
    /// The band's title, and a section's workspace name.
    static let bandTitle: CGFloat = 27
    static let placeName: CGFloat = 19
    /// A forecast's temperature.
    static let temperature: CGFloat = 30
    /// A countdown's figure.
    static let countdown: CGFloat = 46
  }

  // MARK: Radii and depth

  /// A widget on its own (in a conversation's line): the rule round it.
  static let radius: CGFloat = 8
  /// Keys.
  static let controlRadius: CGFloat = 5
  static let controlRadiusLarge: CGFloat = 6
  static let fieldRadius: CGFloat = 9
  static let boxRadius: CGFloat = 3.5
  /// A key's edge below it, and how far it sinks when pressed.
  static let keyEdge: CGFloat = 1.5
  static let sink: CGFloat = 1
  /// The one shadow for what floats over the page (a sheet, a menu).
  static let float = (color: Color.black.opacity(0.2), radius: CGFloat(22), y: CGFloat(18))

  // MARK: Space

  static let gap: CGFloat = 8
  static let gapWide: CGFloat = 14
  /// A cell's inset on a phone: 16 across, 12 down.
  static let inset: CGFloat = 16
  static let cellInset: CGFloat = 12
  /// One line in a list.
  static let row: CGFloat = 44
  /// Keys: large (the one that sends), regular, and small (in a row).
  static let keyLarge: CGFloat = 36
  static let key: CGFloat = 32
  static let keySmall: CGFloat = 26
  static let fieldHeight: CGFloat = 46
  static let checkbox: CGFloat = 16

  // MARK: Marks: one family, on Aicher's 16-unit grid

  /// A mark's size beside words, and in a bank.
  static let mark: CGFloat = 14
  static let markLarge: CGFloat = 20
  static let markSmall: CGFloat = 9
  /// At this size and under, a mark drops its glyph.
  static let markBare: CGFloat = 10
  /// A glyph's stroke, in grid units: straight, at 0, 45 or 90 degrees.
  static let glyph: CGFloat = 1.75
  /// A workspace's mark (a heavy ring, its letter over its station's number).
  static let ring: CGFloat = 20
  static let ringLarge: CGFloat = 30
  static let ringStroke: CGFloat = 2.3

  // MARK: Widgets

  /// A route: its line (the one heavy line, for data with stops), its stops.
  static let rail: CGFloat = 3
  static let stop: CGFloat = 11
  static let stopRing: CGFloat = 2.5
  static let stopNext: CGFloat = 15
  static let stopNextRing: CGFloat = 3
  /// A vertical route's columns (time, line) and its least row.
  static let routeTime: CGFloat = 52
  static let routeLine: CGFloat = 18
  static let routeRow: CGFloat = 30
  /// A forecast's rain gauge: dots this far apart, in a column this tall.
  static let gaugeWidth: CGFloat = 6
  static let gaugePitch: CGFloat = 5
  static let gaugeDot: CGFloat = 2.1
  static let gauge: CGFloat = 30
  /// A ticket's stub.
  static let stub: CGFloat = 74
  /// A chart's height and its line.
  static let chart: CGFloat = 160
  static let stroke: CGFloat = 1.75
  /// Media.
  static let icon: CGFloat = 22
  static let avatar: CGFloat = 40
  static let smallFeature: CGFloat = 100
  static let feature: CGFloat = 200
  static let header: CGFloat = 200
  static let largeFeature: CGFloat = 400
  static let video: CGFloat = 210

  /// Motion: almost none. A change of side or state, at most this: nothing
  /// the person taps moves for longer than 150 ms (mac/DESIGN.md, Motion).
  static let change: Animation = .easeOut(duration: 0.15)

  static func color(day: UInt32, night: UInt32, alpha: (day: CGFloat, night: CGFloat) = (1, 1)) -> Color {
    Color(
      UIColor { traits in
        let dark = traits.userInterfaceStyle == .dark
        let hex = dark ? night : day
        return UIColor(
          red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255,
          alpha: dark ? alpha.night : alpha.day)
      })
  }
}
