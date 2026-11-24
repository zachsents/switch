import SwiftUI

/// One printer: its camera, its job and its controls (`pause`, `resume`, `stop`), temperatures and
/// filament.
struct PrinterView: View {
  let model: Model
  let id: String
  @State private var stopping = false
  @State private var busy = false

  var body: some View {
    let p = model.printers.first { $0.id == id }
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem = model.problem { Problem(text: problem) }
      ScrollView {
        VStack(spacing: 0) {
          CameraView(model: model, printer: id)
          if let p {
            JobLines(printer: p)
            if p.active { controls(p) }
            HStack(spacing: 0) {
              Temp(label: "Nozzle", now: p.nozzle, target: p.nozzleTarget)
              Rectangle().fill(SIS.hair).frame(width: SIS.hairWidth)
              Temp(label: "Bed", now: p.bed, target: p.bedTarget)
            }
            .overlay(alignment: .bottom) { Rule() }
            BoardSection(label: "Filament", count: nil) {
              Rule()
              SlotsRow(model: model, printer: p)
            }
          }
        }
      }
      .refreshable { await model.load() }
    }
    .background(SIS.paper)
    .band(p?.name ?? "Printer")
    .toolbar {
      if let p {
        ToolbarItem(placement: .topBarTrailing) { PhaseMark(printer: p) }
      }
    }
    .confirmationDialog("Stop \(p?.name ?? "")?", isPresented: $stopping, titleVisibility: .visible) {
      Button("Stop", role: .destructive) { run("stop") }
      Button("Keep printing", role: .cancel) {}
    }
    .seen(model.core, "printer", id)
  }

  private func controls(_ p: Printer) -> some View {
    HStack(spacing: 10) {
      if p.phase == "paused" {
        Button("Resume") { run("resume") }.buttonStyle(KeyStyle(go: true))
      } else {
        Button("Pause") { run("pause") }.buttonStyle(KeyStyle())
      }
      Button("Stop") { stopping = true }.buttonStyle(KeyStyle())
      Spacer(minLength: 0)
    }
    .disabled(busy)
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 10)
    .overlay(alignment: .bottom) { Hairline() }
  }

  private func run(_ tool: String) {
    busy = true
    Task {
      await model.act(tool, ["printer": .string(id)])
      busy = false
    }
  }
}

/// A heater: its temperature now, and where it's headed.
private struct Temp: View {
  let label: String
  let now: Int
  let target: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label.uppercased()).font(SIS.text(SIS.Size.label, weight: .semibold)).tracking(0.6).foregroundStyle(SIS.ink3)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("\(now)°").font(SIS.number(SIS.Size.readout)).foregroundStyle(SIS.ink)
        if target > 0 { Text("→ \(target)°").font(SIS.data(12)).foregroundStyle(SIS.ink3) }
      }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, SIS.cellInset)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// What a slot holds now (`set_filament`): type, color and brand. It moves no filament.
struct SwapSheet: View {
  let model: Model
  let printer: Printer
  let slot: Slot
  @Environment(\.dismiss) private var dismiss
  @State private var type = "PLA"
  @State private var color = "FFFFFF"
  @State private var brand = "Generic"
  @State private var problem: String?
  @State private var saving = false

  static let types = ["PLA", "PETG", "ASA", "ABS", "TPU"]
  static let colors = [
    "000000", "FFFFFF", "8E8E8E", "C0C0C0", "C81E23", "F0781E", "F0D228", "289646",
    "009696", "1E5AC8", "14235A", "783CAA", "F08CB4", "6E4628", "E1CDA5", "C8A03C",
  ]

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let problem { Problem(text: problem) }
        ScrollView {
          VStack(spacing: 0) {
            Choices(label: "Type", choices: Self.types, picked: $type)
            VStack(alignment: .leading, spacing: 10) {
              Text("COLOR").font(SIS.text(SIS.Size.label, weight: .semibold)).tracking(0.6).foregroundStyle(SIS.ink3)
              LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 8), spacing: 12) {
                ForEach(Self.colors, id: \.self) { c in
                  Button {
                    color = c
                  } label: {
                    Swatch(hex: c, size: 28, strong: c == color)
                  }
                  .accessibilityLabel(c)
                }
              }
            }
            .padding(.horizontal, SIS.inset)
            .padding(.vertical, SIS.cellInset)
            .overlay(alignment: .bottom) { Hairline() }
            Choices(label: "Brand", choices: ["Generic", "Bambu"], picked: $brand)
          }
        }
      }
      .background(SIS.paper)
      .band("\(printer.name) \(slot.slot == "ext" ? "Spool" : slot.slot)")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Set") { Task { await save() } }.disabled(saving)
        }
      }
    }
    .onAppear {
      if slot.loaded, !slot.type.isEmpty { type = slot.type }
      if slot.loaded, !slot.color.isEmpty { color = String(slot.color.prefix(6)) }
      if slot.brand == "Bambu" { brand = "Bambu" }
    }
    .seen(model.core, "swap", "\(printer.id)/\(slot.slot)")
  }

  private func save() async {
    saving = true
    defer { saving = false }
    do {
      _ = try await model.core.call(
        "set_filament", ["printer": .string(printer.id), "slot": .string(slot.slot), "type": .string(type), "color": .string(color), "brand": .string(brand)])
      await model.load()
      dismiss()
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// One choice of a few, as a row of keys; the picked one is lit.
private struct Choices: View {
  let label: String
  let choices: [String]
  @Binding var picked: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(label.uppercased()).font(SIS.text(SIS.Size.label, weight: .semibold)).tracking(0.6).foregroundStyle(SIS.ink3)
      HStack(spacing: 8) {
        ForEach(choices, id: \.self) { c in
          Button(c) { picked = c }
            .buttonStyle(KeyStyle())
            .overlay(RoundedRectangle(cornerRadius: SIS.controlRadius).stroke(c == picked ? SIS.ink : .clear, lineWidth: 1.5))
        }
      }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, SIS.cellInset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .bottom) { Hairline() }
  }
}
