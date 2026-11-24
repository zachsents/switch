import SceneKit
import SwiftUI

/// A 3D model in chat (STL, 3MF, OBJ, GLB, glTF, USDZ): neutral grey, framed whole, drawn from the
/// core's light copy so a 100 MB scan comes as a few MB. Inline, a drag sideways turns it (up and
/// down still scrolls the chat), a pinch zooms, a tap opens it full screen, where it turns any way.
/// One that can't be read is a file, as any other.
struct ModelView: View {
  let attachment: Attachment
  @State private var scene: SCNScene?
  @State private var failed = false
  @State private var whole = false

  var body: some View {
    Group {
      if failed {
        BlobFile(attachment: attachment).modifier(Opens(attachment: attachment))
      } else {
        ZStack {
          SIS.wash
          if let scene {
            ModelCanvas(scene: scene, inline: true) { whole = true }
          } else {
            ProgressView()
          }
        }
        .aspectRatio(4 / 3, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .framed()
        .modifier(Opens(attachment: attachment, taps: false))
        .accessibilityLabel(attachment.name)
      }
    }
    .task(id: attachment) {
      do {
        // USDZ is SceneKit's own, read whole; the rest come light (Blobs.model).
        let usd = attachment.ext == "usdz" || attachment.ext == "usd"
        let file: URL
        if usd { file = try await Blobs.file(attachment) } else { file = try await Blobs.model(attachment) }
        scene = try await ModelScene.make(file, ext: attachment.ext)
      } catch {
        failed = true
      }
    }
    .fullScreenCover(isPresented: $whole) {
      if let scene { ModelWhole(scene: scene, name: attachment.name) }
    }
  }
}

/// A model full screen: one finger turns it, two move it, a pinch zooms; Close puts it away.
private struct ModelWhole: View {
  let scene: SCNScene
  let name: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button("Close") { dismiss() }.buttonStyle(KeyStyle())
        Text(name).font(SIS.text(15, weight: .semibold)).foregroundStyle(SIS.ink).lineLimit(1).truncationMode(.middle)
          .frame(maxWidth: .infinity)
        Color.clear.frame(width: 60, height: 1)
      }
      .padding(.horizontal, SIS.inset)
      .frame(height: SIS.row)
      Rule()
      ModelCanvas(scene: scene, inline: false, tapped: nil).ignoresSafeArea(edges: .bottom)
    }
    .background(SIS.wash)
  }
}

/// Builds a model's scene: its mesh in grey, centred, a camera that frames it, light from above.
enum ModelScene {
  static func make(_ file: URL, ext: String) async throws -> SCNScene {
    let scene = SCNScene()
    let model = SCNNode()
    model.name = "model"
    let low: SIMD3<Float>
    let high: SIMD3<Float>
    if ext == "usdz" || ext == "usd" {
      let loaded = try SCNScene(url: file)
      for child in loaded.rootNode.childNodes { model.addChildNode(child) }
      let (a, b) = model.boundingBox
      (low, high) = (SIMD3(Float(a.x), Float(a.y), Float(a.z)), SIMD3(Float(b.x), Float(b.y), Float(b.z)))
      model.enumerateHierarchy { node, _ in node.geometry?.materials.forEach(grey) }
    } else {
      let mesh = try await Models.read(file, ext: ext)
      let vertices = SCNGeometrySource(
        data: mesh.vertices, semantic: .vertex, vectorCount: mesh.count, usesFloatComponents: true, componentsPerVector: 3,
        bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
      let normals = SCNGeometrySource(
        data: mesh.normals, semantic: .normal, vectorCount: mesh.count, usesFloatComponents: true, componentsPerVector: 3,
        bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
      let indices = (0..<UInt32(mesh.count)).map { $0 }
      let element = SCNGeometryElement(indices: indices, primitiveType: .triangles)
      let geometry = SCNGeometry(sources: [vertices, normals], elements: [element])
      let material = SCNMaterial()
      grey(material)
      geometry.materials = [material]
      model.geometry = geometry
      (low, high) = (mesh.low, mesh.high)
    }
    let center = (low + high) / 2
    let radius = max(simd_length(high - low) / 2, 0.0001)
    // Turned about its own middle.
    model.pivot = SCNMatrix4MakeTranslation(center.x, center.y, center.z)
    let turn = SCNNode()
    turn.name = "turn"
    turn.addChildNode(model)
    scene.rootNode.addChildNode(turn)

    let camera = SCNCamera()
    camera.fieldOfView = 35
    camera.zNear = Double(radius) * 0.01
    camera.zFar = Double(radius) * 100
    let eye = SCNNode()
    eye.name = "eye"
    eye.camera = camera
    let distance = radius / sin(Float(camera.fieldOfView) * .pi / 360) * 1.1
    eye.simdPosition = SIMD3(0, distance * 0.35, distance)
    eye.simdLook(at: .zero)
    scene.rootNode.addChildNode(eye)

    let key = SCNNode()
    key.light = SCNLight()
    key.light?.type = .directional
    key.light?.intensity = 900
    key.simdEulerAngles = SIMD3(-.pi / 3, .pi / 6, 0)
    scene.rootNode.addChildNode(key)
    let fill = SCNNode()
    fill.light = SCNLight()
    fill.light?.type = .ambient
    fill.light?.intensity = 350
    scene.rootNode.addChildNode(fill)
    return scene
  }

  private static func grey(_ m: SCNMaterial) {
    m.diffuse.contents = UIColor(white: 0.72, alpha: 1)
    m.specular.contents = UIColor(white: 0.15, alpha: 1)
    m.lightingModel = .blinn
    m.isDoubleSided = true
  }
}

/// SceneKit's view of a model. Inline, its own gestures: a sideways drag turns it, a pinch zooms,
/// a tap calls `tapped`. Full screen, SceneKit's camera control.
private struct ModelCanvas: UIViewRepresentable {
  let scene: SCNScene
  let inline: Bool
  let tapped: (() -> Void)?

  func makeUIView(context: Context) -> SCNView {
    let view = SCNView()
    view.scene = scene
    view.backgroundColor = .clear
    view.antialiasingMode = .multisampling4X
    view.pointOfView = scene.rootNode.childNode(withName: "eye", recursively: false)
    if inline {
      let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:)))
      pan.delegate = context.coordinator
      view.addGestureRecognizer(pan)
      view.addGestureRecognizer(UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pinch(_:))))
      view.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap)))
    } else if let eye = view.pointOfView?.clone() {
      // A camera of its own, so turning it here leaves the inline view as it was.
      eye.name = "whole"
      scene.rootNode.addChildNode(eye)
      view.pointOfView = eye
      view.allowsCameraControl = true
      view.defaultCameraController.interactionMode = .orbitTurntable
      view.defaultCameraController.inertiaEnabled = true
    }
    return view
  }

  func updateUIView(_ view: SCNView, context: Context) {}

  static func dismantleUIView(_ view: SCNView, coordinator: Coordinator) {
    if view.pointOfView?.name == "whole" { view.pointOfView?.removeFromParentNode() }
  }

  func makeCoordinator() -> Coordinator { Coordinator(scene: scene, tapped: tapped) }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    let turn: SCNNode?
    let eye: SCNNode?
    let tapped: (() -> Void)?
    private var start: Float = 0
    private var distance: SIMD3<Float> = .zero

    init(scene: SCNScene, tapped: (() -> Void)?) {
      turn = scene.rootNode.childNode(withName: "turn", recursively: false)
      eye = scene.rootNode.childNode(withName: "eye", recursively: false)
      self.tapped = tapped
    }

    /// Only a sideways drag turns it; an upright one is the chat's scroll.
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
      guard let pan = g as? UIPanGestureRecognizer else { return true }
      let v = pan.velocity(in: pan.view)
      return abs(v.x) > abs(v.y)
    }

    @objc func pan(_ g: UIPanGestureRecognizer) {
      guard let turn else { return }
      if g.state == .began { start = turn.simdEulerAngles.y }
      let width = Float(max(g.view?.bounds.width ?? 1, 1))
      turn.simdEulerAngles.y = start + Float(g.translation(in: g.view).x) / width * .pi * 2
    }

    @objc func pinch(_ g: UIPinchGestureRecognizer) {
      guard let eye else { return }
      if g.state == .began { distance = eye.simdPosition }
      let scale = Float(min(max(g.scale, 0.2), 5))
      eye.simdPosition = distance / scale
    }

    @objc func tap() { tapped?() }
  }
}
