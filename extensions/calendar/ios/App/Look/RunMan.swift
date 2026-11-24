import SwiftUI

/// The live mark at `step` of the run cycle (mac/src/ui/marks.rs's
/// `runner`, kept in step with it): a runner facing forward, a round head
/// and limbs as round-ended strokes of one weight, the far arm and leg
/// parted from the near ones by a hairline of paper. `RunMan.rest` is the
/// mark standing still, mid-stride. Running is never a clock: a clock
/// reads as waiting. The one figure everywhere running shows on the
/// iPhone: the app's live marks and turn rows, and the Live Activities.
nonisolated struct RunMan: View {
  let step: Int
  /// Its orange: the app's `SIS.running`, the Live Activities' `Look.running`.
  let ink: Color
  var size: CGFloat = 14

  static let steps = 8
  static let rest = 3
  /// A leg's thigh swing from straight down (forward positive) and how far
  /// its knee folds the shin back, in degrees, at each step; the other leg
  /// is half a cycle on, and each arm swings against its leg.
  private static let thigh: [CGFloat] = [30, 4, -26, -40, -10, 30, 52, 44]
  private static let knee: [CGFloat] = [16, 40, 20, 95, 122, 100, 62, 26]
  /// How far the hips drop on landing and rise in flight, in grid units.
  private static let bounce: [CGFloat] = [0, 0.45, 0.15, -0.35, 0, 0.45, 0.15, -0.35]

  private static func at(_ p: CGPoint, _ degrees: CGFloat, _ length: CGFloat) -> CGPoint {
    let a = degrees * .pi / 180
    return CGPoint(x: p.x + length * sin(a), y: p.y + length * cos(a))
  }

  var body: some View {
    Canvas { context, canvas in
      let k = canvas.width / 16
      let step = ((step % Self.steps) + Self.steps) % Self.steps
      let other = (step + Self.steps / 2) % Self.steps
      let hip = CGPoint(x: 7.2, y: 8.4 + Self.bounce[step])
      let shoulder = Self.at(hip, 166, 3.9)
      let head = Self.at(shoulder, 158, 2.45)
      func leg(_ i: Int) -> [CGPoint] {
        let knee = Self.at(hip, Self.thigh[i], 3.1)
        return [hip, knee, Self.at(knee, Self.thigh[i] - Self.knee[i], 3.2)]
      }
      func arm(_ i: Int) -> [CGPoint] {
        let swing = 4 - 1.2 * Self.thigh[i]
        let elbow = Self.at(shoulder, swing, 2.6)
        return [shoulder, elbow, Self.at(elbow, swing + 88, 2.2)]
      }
      func path(_ points: [CGPoint]) -> Path {
        Path { p in p.addLines(points.map { CGPoint(x: $0.x * k, y: $0.y * k) }) }
      }
      func style(_ width: CGFloat) -> StrokeStyle { StrokeStyle(lineWidth: width * k, lineCap: .round, lineJoin: .round) }
      let (near, far) = ([leg(step), arm(other)], [leg(other), arm(step)])
      let ink = GraphicsContext.Shading.color(self.ink)
      context.drawLayer { layer in
        for limb in far { layer.stroke(path(limb), with: ink, style: style(1.9)) }
        // The hairline of paper between the far limbs and the near ones.
        layer.blendMode = .destinationOut
        for limb in near { layer.stroke(path(limb), with: .color(.black), style: style(1.9 + 2 * 0.55)) }
        layer.blendMode = .normal
        layer.stroke(path([shoulder, hip]), with: ink, style: style(1.9))
        layer.fill(Path(ellipseIn: CGRect(x: (head.x - 1.7) * k, y: (head.y - 1.7) * k, width: 3.4 * k, height: 3.4 * k)), with: ink)
        for limb in near { layer.stroke(path(limb), with: ink, style: style(1.9)) }
      }
    }
    .frame(width: size, height: size)
  }
}
