import SwiftUI

/// Every batch of changes, newest first (`log`), each with its Undo (`undo`), which takes back what
/// it sent to Apple or Google too.
struct HistoryView: View {
  let model: Model
  @State private var batches: [JSON] = []
  @State private var problem: String?
  @State private var undoing: String?

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem { Problem(text: problem) }
      ScrollView {
        LazyVStack(spacing: 0) {
          if batches.isEmpty { Empty("Nothing yet") }
          ForEach(batches, id: \.self) { b in
            let batch = b["batch"].str
            HStack(spacing: 10) {
              VStack(alignment: .leading, spacing: 2) {
                Text(b["reason"].str.replacingOccurrences(of: "-", with: " ").capitalized).font(SIS.text(15)).foregroundStyle(SIS.ink)
                Text(when(b["at"].number ?? 0)).font(SIS.data()).foregroundStyle(SIS.ink3)
              }
              Spacer(minLength: 8)
              Figure("\(Int(b["events"].number ?? 0))")
              if b["undone"].bool != true {
                Button("Undo") { Task { await undo(batch) } }
                  .buttonStyle(KeyStyle())
                  .disabled(undoing != nil)
              }
            }
            .padding(.horizontal, SIS.inset)
            .padding(.vertical, 8)
            .frame(minHeight: SIS.row)
            .overlay(alignment: .bottom) { Hairline() }
          }
        }
      }
    }
    .background(SIS.paper)
    .band("History")
    .task(id: model.changes) { await load() }
    .seen(model.core, "history")
  }

  private func when(_ ms: Double) -> String {
    Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.month(.abbreviated).day().hour().minute())
  }

  private func load() async {
    do {
      batches = try await model.core.call("log", ["limit": 60])["batches"].array
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }

  private func undo(_ batch: String) async {
    undoing = batch
    defer { undoing = nil }
    do { try await model.undo(batch) } catch { problem = error.localizedDescription }
  }
}
