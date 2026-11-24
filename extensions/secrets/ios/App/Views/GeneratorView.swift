import SwiftUI

/// A new password: its style, length, digits and symbols, made afresh on every change. Use puts it
/// in the field being edited.
struct GeneratorView: View {
  let model: Model
  let use: (String) -> Void
  @State private var style: Generator.Style = .random
  @State private var length = 20.0
  @State private var digits = true
  @State private var symbols = true
  @State private var value = ""
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 0) {
          Text(value)
            .font(SIS.data(18, weight: .medium))
            .foregroundStyle(SIS.ink)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .padding(.horizontal, SIS.inset)
            .textSelection(.enabled)
            .overlay(alignment: .bottom) { Rule() }
          BoardSection(label: "Style", first: true) {
            Rule()
            VStack(alignment: .leading, spacing: 12) {
              Picker("Style", selection: $style) {
                ForEach(Generator.Style.allCases) { Text($0.label).tag($0) }
              }
              .pickerStyle(.segmented)
              if style == .random {
                HStack {
                  Text("Length").font(SIS.text(15))
                  Slider(value: $length, in: 8...64, step: 1).tint(SIS.ink2)
                  Text("\(Int(length))").font(SIS.data(13)).frame(width: 28, alignment: .trailing)
                }
                Toggle("Digits", isOn: $digits).font(SIS.text(15)).tint(SIS.Key.goTop)
                Toggle("Symbols", isOn: $symbols).font(SIS.text(15)).tint(SIS.Key.goTop)
              }
            }
            .padding(SIS.inset)
          }
          HStack(spacing: SIS.gap) {
            Spacer()
            IconKey(symbol: "arrow.clockwise", label: "Again") { make() }
            Button("Use") {
              use(value)
              dismiss()
            }
            .buttonStyle(KeyStyle(go: true))
          }
          .padding(SIS.inset)
        }
      }
      .background(SIS.paper)
      .band("Generate")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
      }
    }
    .onAppear { make() }
    .onChange(of: style) { make() }
    .onChange(of: length) { make() }
    .onChange(of: digits) { make() }
    .onChange(of: symbols) { make() }
  }

  private func make() {
    value = Generator.make(style: style, length: Int(length), digits: digits, symbols: symbols)
  }
}
