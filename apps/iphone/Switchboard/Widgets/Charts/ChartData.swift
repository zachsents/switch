import A2UICore
import Foundation
import OrderedJSON
import SwiftUI

/// What a chart is given, read defensively (desktop's widgets/charts/data.ts): any of it may be bound
/// to the surface's data model, where anything can arrive. A value that can't be read is none; a
/// series, slice, point or day that can't be read is left out. With nothing left, a chart draws
/// nothing. Colors go by place, never cycled; past a cap the rest fold into Other, in the gray that
/// steps back, where they add up, else aren't drawn.
enum ChartData {
  /// How many series a chart draws, slices a ring, series of points a scatter.
  static let cap = 8
  static let slicesCap = 6
  static let pointsCap = 3
  static let otherName = "Other"
  static let other = SIS.ink3

  static func color(_ i: Int) -> Color { i < SIS.series.count ? SIS.series[i] : other }

  struct Series: Identifiable {
    let name: String
    let color: Color
    let values: [Double?]
    let place: Int
    var id: Int { place }
  }

  struct Slice: Identifiable {
    let label: String
    let value: Double
    let color: Color
    let place: Int
    var id: Int { place }
  }

  struct Point: Identifiable {
    let x: Double
    let y: Double
    let id: Int
  }

  struct Points: Identifiable {
    let name: String
    let color: Color
    let points: [Point]
    let place: Int
    var id: Int { place }
  }

  static func number(_ v: JSONValue?) -> Double? {
    guard let d = v?.doubleValue, d.isFinite else { return nil }
    return d
  }

  /// The numbers among raw values.
  static func numbers(_ v: JSONValue?) -> [Double] { (v?.arrayValue ?? []).compactMap(number) }

  /// Labels as words: a number reads as itself.
  static func labels(_ v: JSONValue?) -> [String] {
    (v?.arrayValue ?? []).map { l in
      if let s = l.stringValue { return s }
      return number(l).map { Figures.bare.figure($0) } ?? ""
    }
  }

  /// A sum of what's there; none when nothing is.
  static func sum(_ values: [Double?]) -> Double? {
    let present = values.compactMap { $0 }
    return present.isEmpty ? nil : present.reduce(0, +)
  }

  /// Named series with a value for each of `count` labels, or none. Past the cap the rest are summed
  /// into Other when `sum` (parts of a whole), else not drawn.
  static func series(_ v: JSONValue?, count: Int, sum adding: Bool) -> [Series] {
    let read = (v?.arrayValue ?? []).compactMap { s -> (String, [JSONValue])? in
      guard let o = s.objectValue, let name = o["name"]?.stringValue, let values = o["values"]?.arrayValue else { return nil }
      return (name, values)
    }
    .enumerated().map { i, s in
      Series(name: s.0, color: color(i), values: (0..<count).map { j in j < s.1.count ? number(s.1[j]) : nil }, place: i)
    }
    guard read.count > cap else { return read }
    guard adding else { return Array(read.prefix(cap)) }
    let rest = read.dropFirst(cap - 1)
    let other = Series(
      name: otherName, color: other, values: (0..<count).map { j in sum(rest.map { $0.values[j] }) }, place: cap - 1)
    return Array(read.prefix(cap - 1)) + [other]
  }

  static func anyValue(_ series: [Series]) -> Bool { series.contains { $0.values.contains { $0 != nil } } }

  /// Parts of a whole: the slices with something in them; past six, Other.
  static func slices(_ v: JSONValue?) -> [Slice] {
    let read = (v?.arrayValue ?? []).compactMap { s -> (String, Double)? in
      guard let o = s.objectValue, let label = o["label"]?.stringValue, let value = number(o["value"]), value > 0 else { return nil }
      return (label, value)
    }
    .enumerated().map { i, s in Slice(label: s.0, value: s.1, color: color(i), place: i) }
    guard read.count > slicesCap else { return read }
    let rest = read.dropFirst(slicesCap - 1)
    let other = Slice(label: otherName, value: rest.reduce(0) { $0 + $1.value }, color: other, place: slicesCap - 1)
    return Array(read.prefix(slicesCap - 1)) + [other]
  }

  /// Series of points: the first three.
  static func points(_ v: JSONValue?) -> [Points] {
    let read = (v?.arrayValue ?? []).compactMap { s -> (String, [Point])? in
      guard let o = s.objectValue, let name = o["name"]?.stringValue, let raw = o["points"]?.arrayValue else { return nil }
      let points = raw.enumerated().compactMap { k, p -> Point? in
        guard let pair = p.arrayValue, pair.count == 2, let x = number(pair[0]), let y = number(pair[1]) else { return nil }
        return Point(x: x, y: y, id: k)
      }
      return points.isEmpty ? nil : (name, points)
    }
    return read.prefix(pointsCap).enumerated().map { i, s in Points(name: s.0, color: color(i), points: s.1, place: i) }
  }

  /// A value per day, by the day; a day given twice keeps its last.
  static func days(_ v: JSONValue?) -> [Date: Double] {
    var days: [Date: Double] = [:]
    for d in v?.arrayValue ?? [] {
      guard let o = d.objectValue, let date = o["date"]?.stringValue, let value = number(o["value"]),
        let day = dayOf(date)
      else { continue }
      days[day] = value
    }
    return days
  }

  static let calendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC") ?? .current
    return c
  }()

  /// A real day ("2026-11-02"), or none ("2026-02-30").
  static func dayOf(_ text: String) -> Date? {
    let parts = text.split(separator: "-")
    guard text.count == 10, parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
      let date = calendar.date(from: DateComponents(year: y, month: m, day: d)),
      calendar.component(.day, from: date) == d, calendar.component(.month, from: date) == m
    else { return nil }
    return date
  }
}

/// How a chart's figures read (desktop's figures.ts): a prefix and a suffix round each, the sign
/// before them; ticks compact from 1,000 up, a figure standing alone from 10,000.
struct Figures {
  let prefix: String
  let suffix: String

  static let bare = Figures(prefix: "", suffix: "")

  init(prefix: String, suffix: String) {
    self.prefix = prefix
    self.suffix = suffix
  }

  init(_ node: Node) {
    prefix = node.string(for: "prefix") ?? ""
    suffix = node.string(for: "suffix") ?? ""
  }

  private func read(_ v: Double, compact: Bool) -> String {
    let a = abs(v)
    let digits =
      compact
      ? a.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)).rounded(rule: .toNearestOrAwayFromZero))
      : a.formatted(.number.precision(.fractionLength(0...2)).rounded(rule: .toNearestOrAwayFromZero))
    return "\(v < 0 ? "-" : "")\(prefix)\(digits)\(suffix)"
  }

  /// A value in full: "-$1,284.5".
  func figure(_ v: Double) -> String { read(v, compact: false) }
  /// An axis's tick, compact from 1,000: "$1.2K".
  func tick(_ v: Double) -> String { read(v, compact: abs(v) >= 1000) }
  /// A figure standing alone (a ring's total), compact from 10,000.
  func headline(_ v: Double) -> String { read(v, compact: abs(v) >= 10_000) }
  /// A part of a whole: "32%".
  static func percent(_ part: Double) -> String { part.formatted(.percent.precision(.fractionLength(0))) }
}

/// A value axis's scale (desktop's ticks.ts): from a multiple of a round step (1, 2, 2.5 or 5 times a
/// power of ten) below the least to one above the most, about four steps apart, ticked at each.
struct ChartScale {
  let lo: Double
  let hi: Double
  let ticks: [Double]

  static func step(_ raw: Double, whole: Bool = false) -> Double {
    let power = pow(10, floor(log10(raw)))
    let step = ([1, 2, 2.5, 5, 10].first { $0 * power >= raw * (1 - 1e-9) } ?? 10) * power
    guard whole else { return step }
    if step < 1 { return 1 }
    return step.rounded() == step ? step : step * 2
  }

  /// A tick without a float's error.
  private static func clean(_ v: Double) -> Double { Double(String(format: "%.12g", v)) ?? v }

  init(min: Double, max: Double, zero: Bool, whole: Bool = false) {
    var lo = zero ? Swift.min(0, min) : min
    var hi = zero ? Swift.max(0, max) : max
    if hi - lo <= 0 {
      lo -= lo == 0 ? 0 : 1
      hi += 1
    }
    let step = Self.step((hi - lo) / 4, whole: whole)
    let from = Int(floor(lo / step + 1e-9))
    let to = Int(ceil(hi / step - 1e-9))
    ticks = (from...to).map { Self.clean(Double($0) * step) }
    self.lo = Self.clean(Double(from) * step)
    self.hi = Self.clean(Double(to) * step)
  }

  /// The scale for values, from zero when `zero`.
  init(_ values: [Double?], zero: Bool, whole: Bool = false) {
    let present = values.compactMap { $0 }
    self.init(min: present.min() ?? 0, max: present.max() ?? 0, zero: zero, whole: whole)
  }
}
