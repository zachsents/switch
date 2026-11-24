import ActivityKit
import SwiftUI
import WidgetKit

/// Switchboard's widget extension: the agent's Live Activities (Shared/SwitchActivity.swift), in
/// the app's look on the lock screen's dark. Three templates: progress (a bar), countdown (the time
/// left, big) and status (a line that changes).
@main
struct Activities: WidgetBundle {
  var body: some Widget {
    SwitchLiveActivity()
  }
}

struct SwitchLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SwitchActivity.self) { context in
      LockScreen(attributes: context.attributes, state: context.state)
        .activityBackgroundTint(Look.ground)
        .activitySystemActionForegroundColor(.white)
        .widgetURL(Look.link(context.attributes))
    } dynamicIsland: { context in
      let ink = Look.ink(context.attributes)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 7) {
            Ring(name: context.attributes.space, ink: ink, size: 22)
            Text(context.attributes.space).font(.system(size: 13, weight: .medium)).foregroundStyle(Look.ink2).lineLimit(1)
          }
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Mark(state: context.state).padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 10) {
            Text(context.state.title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
            TemplateView(template: context.attributes.template, state: context.state, ink: ink)
          }
          .padding(.horizontal, 4)
        }
      } compactLeading: {
        Ring(name: context.attributes.space, ink: ink, size: 20)
      } compactTrailing: {
        Mark(state: context.state, compact: true).foregroundStyle(.white)
      } minimal: {
        Ring(name: context.attributes.space, ink: ink, size: 20)
      }
      .widgetURL(Look.link(context.attributes))
      .keylineTint(ink)
    }
  }
}

/// The lock screen's cell: the ring and the space quietly, the mark at the right; the title, the
/// line the eye lands on; then the template's own part.
struct LockScreen: View {
  let attributes: SwitchActivity
  let state: SwitchActivity.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Ring(name: attributes.space, ink: Look.ink(attributes), size: 20)
        Text(attributes.space).font(.system(size: 13, weight: .medium)).foregroundStyle(Look.ink2).lineLimit(1)
        Spacer(minLength: 4)
        Mark(state: state)
      }
      Text(state.title).font(.system(size: 17, weight: .semibold)).lineLimit(1).padding(.top, 8)
      TemplateView(template: attributes.template, state: state, ink: Look.ink(attributes)).padding(.top, 10)
    }
    .foregroundStyle(.white)
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
  }
}

/// What each template shows under the title.
struct TemplateView: View {
  let template: String
  let state: SwitchActivity.ContentState
  let ink: Color

  var body: some View {
    switch template {
    case "countdown":
      HStack(alignment: .firstTextBaseline) {
        if let ends = state.ends, ends > Date(), state.state == "running" {
          Text(timerInterval: Date()...ends, countsDown: true)
            .font(.system(size: 40, weight: .bold).monospacedDigit())
            .contentTransition(.numericText(countsDown: true))
        } else if let ends = state.ends {
          Text(ends.formatted(date: .omitted, time: .shortened)).font(.system(size: 40, weight: .bold).monospacedDigit())
        }
        Spacer(minLength: 0)
        if let line = state.line { Text(line).font(.system(size: 13)).foregroundStyle(Look.ink2).lineLimit(1) }
      }
    case "progress":
      VStack(alignment: .leading, spacing: 8) {
        if let line = state.line { Text(line).font(.system(size: 13)).foregroundStyle(Look.ink2).lineLimit(1) }
        Bar(state: state, ink: ink)
      }
    default:
      if let line = state.line { Text(line).font(.system(size: 15)).foregroundStyle(Look.ink2).lineLimit(2) }
    }
  }
}

/// How it stands, as the app's marks say it: the runner while it runs (with the time left when
/// it has an end), a hand when it needs the user, a check when done, the octagon when it failed.
struct Mark: View {
  let state: SwitchActivity.ContentState
  var compact = false

  var body: some View {
    HStack(spacing: 4) {
      switch state.state {
      case "done":
        Image(systemName: "checkmark")
      case "failed":
        Image(systemName: "xmark.octagon.fill").foregroundStyle(Look.stopped)
      case "needs":
        Image(systemName: "hand.raised.fill").foregroundStyle(Look.needs)
      default:
        if let ends = state.ends, ends > Date() {
          Text(timerInterval: Date()...ends, countsDown: true)
            .multilineTextAlignment(.trailing)
            .frame(width: ends.timeIntervalSinceNow >= 3600 ? 52 : 40, alignment: .trailing)
        } else if let progress = state.progress {
          Text("\(Int((progress * 100).rounded()))%")
        } else {
          RunMan(step: RunMan.rest, ink: Look.running, size: 16)
        }
      }
    }
    .font(.system(size: 13, weight: .semibold).monospacedDigit())
    .lineLimit(1)
    .fixedSize()
  }
}

/// The bar: filled to the progress given, else moving on its own from start to end.
struct Bar: View {
  let state: SwitchActivity.ContentState
  let ink: Color

  var body: some View {
    Group {
      if let progress = state.progress {
        ProgressView(value: min(1, max(0, state.state == "done" ? 1 : progress)))
      } else if let ends = state.ends, ends > state.started {
        ProgressView(timerInterval: state.started...ends, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
      } else {
        ProgressView(value: state.state == "done" ? 1 : 0)
      }
    }
    .progressViewStyle(.linear)
    .tint(state.state == "failed" ? Look.stopped : ink)
    .labelsHidden()
    .background(Capsule().fill(Look.track).frame(height: 4))
  }
}

/// A space's ring: a disc ringed in its ink, its initial inside; Home's holds a house.
struct Ring: View {
  let name: String
  let ink: Color
  var size: CGFloat = 20

  var body: some View {
    let k = size / 16
    ZStack {
      Circle().fill(Look.ground)
      Circle().stroke(ink, lineWidth: 2.3 * k).padding(1.15 * k)
      if name == "Home" {
        Image(systemName: "house").font(.system(size: 7 * k, weight: .bold))
      } else {
        Text(String(name.prefix(1)).uppercased()).font(.system(size: 7.4 * k, weight: .bold))
      }
    }
    .foregroundStyle(.white)
    .frame(width: size, height: size)
  }
}

/// The app's colors, as SIS sets them, for the lock screen's dark.
enum Look {
  static let ground = Color(red: 0.05, green: 0.05, blue: 0.05)
  static let ink2 = Color(white: 0.66)
  static let track = Color.white.opacity(0.28)
  static let running = Color(red: 0xF2 / 255, green: 0x64 / 255, blue: 0x19 / 255)
  static let stopped = Color(red: 0xD4 / 255, green: 0x2A / 255, blue: 0x1F / 255)
  static let needs = Color(red: 1, green: 0xC0 / 255, blue: 0)
  static let plain = Color(red: 0x9A / 255, green: 0xA7 / 255, blue: 0xB2 / 255)

  static func ink(_ attributes: SwitchActivity) -> Color {
    color(attributes.night) ?? color(attributes.ink) ?? plain
  }

  static func link(_ attributes: SwitchActivity) -> URL? {
    URL(string: "switchboard://space/\(attributes.spaceId ?? "home")")
  }

  static func color(_ hex: String?) -> Color? {
    guard let hex = hex?.trimmingCharacters(in: .whitespaces), hex.hasPrefix("#"), hex.count == 7,
      let value = UInt32(hex.dropFirst(), radix: 16)
    else { return nil }
    return Color(red: Double(value >> 16 & 0xFF) / 255, green: Double(value >> 8 & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
  }
}
