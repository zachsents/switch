import SwiftUI

/// The root: each printer as a section, its camera, its job and its filament.
struct PrintersView: View {
  let model: Model

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem = model.problem { Problem(text: problem) }
      ScrollView {
        LazyVStack(spacing: 0) {
          if model.printers.isEmpty && model.problem == nil { Empty("No printers") }
          ForEach(Array(model.printers.enumerated()), id: \.element.id) { i, p in
            VStack(spacing: 0) {
              if i > 0 { Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth) }
              RowButton(action: { model.path.append(.printer(p.id)) }) {
                Text(p.name.uppercased()).font(SIS.sign(20)).tracking(0.5)
                Spacer(minLength: 8)
                PhaseMark(printer: p)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(SIS.ink3)
              }
              CameraView(model: model, printer: p.id)
              JobLines(printer: p)
              SlotsRow(model: model, printer: p)
            }
          }
        }
      }
      .refreshable { await model.load() }
    }
    .background(SIS.paper)
    .band("Printing")
    .seen(model.core, "printers")
  }
}

/// How a printer stands, as a mark: running, paused (needs you), stopped, or a warning.
struct PhaseMark: View {
  let printer: Printer

  var body: some View {
    if !printer.online || printer.phase == "failed" {
      Stop()
    } else if printer.phase == "paused" {
      Hand()
    } else if printer.phase == "printing" || printer.phase == "preparing" {
      Runner()
    } else if !printer.errors.isEmpty {
      Warn()
    }
  }
}

/// The job: its file, a bar, how far and how long; then what's wrong, if anything.
struct JobLines: View {
  let printer: Printer

  var body: some View {
    ForEach(printer.errors, id: \.self) { e in
      HStack(spacing: 8) {
        Warn(size: 12)
        Text(e).font(SIS.text(13)).foregroundStyle(SIS.ink).lineLimit(3)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, SIS.inset)
      .padding(.vertical, 9)
      .overlay(alignment: .bottom) { Hairline() }
    }
    if printer.active {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline) {
          Text(printer.phase == "printing" ? printer.file : (printer.stage.isEmpty ? printer.file : printer.stage))
            .font(SIS.text(14)).foregroundStyle(SIS.ink).lineLimit(1)
          Spacer(minLength: 8)
          Text("\(printer.percent)%").font(SIS.number(SIS.Size.readout)).foregroundStyle(printer.phase == "paused" ? SIS.needs : SIS.running)
        }
        GeometryReader { g in
          ZStack(alignment: .leading) {
            Rectangle().fill(SIS.hair)
            Rectangle().fill(printer.phase == "paused" ? SIS.needs : SIS.running).frame(width: g.size.width * CGFloat(printer.percent) / 100)
          }
        }
        .frame(height: 4)
        HStack {
          if printer.layers > 0 { Figure("\(printer.layer)/\(printer.layers)") }
          Spacer(minLength: 8)
          if let ends = printer.endsAt { Figure(left(ends) + " · " + ends.formatted(date: .omitted, time: .shortened)) }
        }
      }
      .padding(.horizontal, SIS.inset)
      .padding(.vertical, SIS.cellInset)
      .overlay(alignment: .bottom) { Hairline() }
    } else if !printer.file.isEmpty {
      HStack {
        Text(printer.file).font(SIS.text(14)).foregroundStyle(SIS.ink2).lineLimit(1)
        Spacer(minLength: 8)
      }
      .padding(.horizontal, SIS.inset)
      .frame(minHeight: SIS.row)
      .overlay(alignment: .bottom) { Hairline() }
    }
  }

  private func left(_ ends: Date) -> String {
    let minutes = max(0, Int(ends.timeIntervalSinceNow / 60))
    return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
  }
}

/// A printer's camera, a frame a second (`camera`) while it's on screen.
struct CameraView: View {
  let model: Model
  let printer: String
  @State private var frame: UIImage?
  @State private var problem: String?

  var body: some View {
    ZStack {
      Rectangle().fill(SIS.desk)
      if let frame {
        Image(uiImage: frame).resizable().aspectRatio(contentMode: .fit)
      } else if let problem {
        Text(problem).font(SIS.text(12)).foregroundStyle(SIS.ink3).multilineTextAlignment(.center).padding()
      }
    }
    .aspectRatio(16 / 9, contentMode: .fit)
    .frame(maxWidth: .infinity)
    .overlay(alignment: .bottom) { Hairline() }
    .task(id: printer) {
      while !Task.isCancelled {
        if model.active {
          do {
            let r = try await model.core.call("camera", ["printer": .string(printer)])
            if let data = Data(base64Encoded: r["data"].str), let image = UIImage(data: data) {
              frame = image
              problem = nil
            }
          } catch {
            if frame == nil { problem = error.localizedDescription }
          }
        }
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }
}

/// Each AMS slot (or the external spool) as a swatch and its type; a tap swaps what it holds.
struct SlotsRow: View {
  let model: Model
  let printer: Printer
  @State private var swapping: Slot?

  var body: some View {
    HStack(spacing: 0) {
      ForEach(Array(printer.slots.enumerated()), id: \.element.id) { i, s in
        Button {
          swapping = s
        } label: {
          VStack(spacing: 5) {
            Swatch(hex: s.loaded ? s.color : "", size: 22, strong: s.active)
            Text(s.loaded && !s.type.isEmpty ? s.type : "—").font(SIS.data(11)).foregroundStyle(SIS.ink)
            Text(s.slot == "ext" ? "Spool" : s.slot).font(SIS.data(10)).foregroundStyle(SIS.ink3)
          }
          .frame(maxWidth: .infinity, minHeight: 74)
          .contentShape(Rectangle())
        }
        .buttonStyle(Lit())
        .disabled(s.rfid)
        if i < printer.slots.count - 1 { Rectangle().fill(SIS.hair).frame(width: SIS.hairWidth) }
      }
    }
    .overlay(alignment: .bottom) { Rule() }
    .sheet(item: $swapping) { s in
      SwapSheet(model: model, printer: printer, slot: s)
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(SIS.radius)
    }
  }
}

/// A filament's color: a disc, a ring when empty, a heavier ring on the one feeding.
struct Swatch: View {
  let hex: String
  var size: CGFloat = 18
  var strong = false

  var body: some View {
    ZStack {
      if let c = Swatch.color(hex) {
        Circle().fill(c)
        Circle().stroke(SIS.rule, lineWidth: 1)
      } else {
        Circle().stroke(SIS.off, lineWidth: 1.5)
      }
      if strong { Circle().stroke(SIS.running, lineWidth: 2.5).padding(-4) }
    }
    .frame(width: size, height: size)
  }

  static func color(_ hex: String) -> Color? {
    guard hex.count >= 6, let v = UInt32(hex.prefix(6), radix: 16) else { return nil }
    return Color(red: Double(v >> 16 & 0xFF) / 255, green: Double(v >> 8 & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
  }
}
