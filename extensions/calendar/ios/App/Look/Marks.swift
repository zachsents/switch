import SwiftUI

// The marks every screen shares (SIS rev D), on Aicher's 16-unit grid, as the desktop draws them
// (apps/desktop/src/mainview/ui/marks.tsx). Needs you is a yellow hand, live an orange runner,
// unexpected a red triangle, stopped a red octagon. A space's ring is a station on its line.

private func grid(_ size: CGFloat, _ build: (inout Path, CGFloat) -> Void) -> Path {
  var p = Path()
  build(&p, size / 16)
  return p
}

/// Needs you: a raised right hand, palm out. Never a warning sign.
struct Hand: View {
  var size: CGFloat = SIS.mark

  var body: some View {
    Canvas { c, s in
      let k = s.width / 16
      let fingers = grid(s.width) { p, k in
        for (x, top) in [(4.75, 4.4), (7.35, 2.7), (9.95, 2.95), (12.45, 4.7)] {
          p.move(to: CGPoint(x: x * k, y: top * k))
          p.addLine(to: CGPoint(x: x * k, y: 9 * k))
        }
      }
      c.stroke(fingers, with: .color(SIS.needs), style: StrokeStyle(lineWidth: 1.9 * k, lineCap: .round))
      let thumb = grid(s.width) { p, k in
        p.move(to: CGPoint(x: 5.1 * k, y: 11.1 * k))
        p.addLine(to: CGPoint(x: 2.55 * k, y: 8.35 * k))
      }
      c.stroke(thumb, with: .color(SIS.needs), style: StrokeStyle(lineWidth: 2.1 * k, lineCap: .round))
      let palm = grid(s.width) { p, k in
        p.move(to: CGPoint(x: 3.8 * k, y: 8 * k))
        p.addLine(to: CGPoint(x: 13.4 * k, y: 8 * k))
        p.addLine(to: CGPoint(x: 13.4 * k, y: 10.6 * k))
        p.addQuadCurve(to: CGPoint(x: 9.1 * k, y: 14.9 * k), control: CGPoint(x: 13.4 * k, y: 14.9 * k))
        p.addLine(to: CGPoint(x: 8.2 * k, y: 14.9 * k))
        p.addQuadCurve(to: CGPoint(x: 3.8 * k, y: 10.6 * k), control: CGPoint(x: 3.8 * k, y: 14.9 * k))
        p.closeSubpath()
      }
      c.fill(palm, with: .color(SIS.needs))
    }
    .frame(width: size, height: size)
    .accessibilityLabel("Needs you")
  }
}

/// Didn't finish, or can't: a red octagon.
struct Stop: View {
  var size: CGFloat = SIS.mark

  var body: some View {
    Canvas { c, s in
      let k = s.width / 16
      let points: [(CGFloat, CGFloat)] = [(14.42, 10.66), (10.66, 14.42), (5.34, 14.42), (1.58, 10.66), (1.58, 5.34), (5.34, 1.58), (10.66, 1.58), (14.42, 5.34)]
      let octagon = Path { p in p.addLines(points.map { CGPoint(x: $0.0 * k, y: $0.1 * k) }); p.closeSubpath() }
      c.fill(octagon, with: .color(SIS.stopped))
      if s.width > SIS.markBare {
        let bar = Path { p in p.move(to: CGPoint(x: 5.1 * k, y: 8 * k)); p.addLine(to: CGPoint(x: 10.9 * k, y: 8 * k)) }
        c.stroke(bar, with: .color(SIS.onMark), style: StrokeStyle(lineWidth: 1.75 * k, lineCap: .round))
      }
    }
    .frame(width: size, height: size)
    .accessibilityLabel("Stopped")
  }
}

/// Didn't go as expected: a red triangle.
struct Warn: View {
  var size: CGFloat = SIS.mark

  var body: some View {
    Canvas { c, s in
      let k = s.width / 16
      let tri = Path { p in
        p.move(to: CGPoint(x: 8 * k, y: 1.9 * k))
        p.addLine(to: CGPoint(x: 14.6 * k, y: 13.9 * k))
        p.addLine(to: CGPoint(x: 1.4 * k, y: 13.9 * k))
        p.closeSubpath()
      }
      c.fill(tri, with: .color(SIS.stopped))
      c.stroke(tri, with: .color(SIS.stopped), style: StrokeStyle(lineWidth: 1.5 * k, lineJoin: .round))
      if s.width > SIS.markBare {
        let bar = Path { p in p.move(to: CGPoint(x: 8 * k, y: 6.1 * k)); p.addLine(to: CGPoint(x: 8 * k, y: 9.6 * k)) }
        c.stroke(bar, with: .color(SIS.onMark), style: StrokeStyle(lineWidth: 1.75 * k, lineCap: .round))
        c.fill(Path(ellipseIn: CGRect(x: 7 * k, y: 10.85 * k, width: 2 * k, height: 2 * k)), with: .color(SIS.onMark))
      }
    }
    .frame(width: size, height: size)
    .accessibilityLabel("Unexpected")
  }
}

/// Running: the orange runner, always running, every runner on one clock, eight poses a second.
struct Runner: View {
  var size: CGFloat = SIS.mark

  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.125)) { t in
      let ms = t.date.timeIntervalSince1970 * 1000
      RunMan(step: Int(ms / 125) % RunMan.steps, ink: SIS.running, size: size)
    }
    .frame(width: size, height: size)
    .accessibilityLabel("Running")
  }
}

/// A space's ring: its code in its ink; Home's holds a house.
struct Ring: View {
  let code: String
  let ink: Color
  var size: CGFloat = 18
  var fill: Color = SIS.paper
  var type: Color = SIS.ink
  var home = false

  var body: some View {
    let k = size / 16
    let letter = String(code.prefix { !$0.isNumber })
    let number = String(code.drop { !$0.isNumber })
    let wide = letter.count > 1
    ZStack {
      Circle().fill(fill)
      Circle().stroke(ink, lineWidth: 2.3 * k).padding(1.15 * k)
      if home {
        Canvas { c, s in
          let k = s.width / 16
          let house = Path { p in
            let m = { (x: CGFloat, y: CGFloat) in CGPoint(x: (3 + x * 0.625) * k, y: (3 + y * 0.625) * k) }
            p.move(to: m(2.6, 7.6)); p.addLine(to: m(8, 2.9)); p.addLine(to: m(13.4, 7.6))
            p.move(to: m(4.4, 6.3)); p.addLine(to: m(4.4, 13.1)); p.addLine(to: m(11.6, 13.1)); p.addLine(to: m(11.6, 6.3))
            p.move(to: m(6.6, 13.1)); p.addLine(to: m(6.6, 9.6)); p.addLine(to: m(9.4, 9.6)); p.addLine(to: m(9.4, 13.1))
          }
          c.stroke(house, with: .color(ink), style: StrokeStyle(lineWidth: 1.6 * 0.625 * k, lineCap: .round, lineJoin: .round))
        }
      } else if !letter.isEmpty && number.isEmpty {
        Text(letter).font(.system(size: (wide ? 5.6 : 7.4) * k, weight: .bold))
      } else if !letter.isEmpty {
        VStack(spacing: -0.6 * k) {
          Text(letter).font(.system(size: (wide ? 3.7 : 4.3) * k, weight: .bold))
          Text(number).font(.system(size: 5.3 * k, weight: .bold).monospacedDigit())
        }
      }
    }
    .foregroundStyle(type)
    .frame(width: size, height: size)
  }
}
