import SwiftUI

/// The root: two weeks from today (`list`), a section a day, the same meeting once.
struct AgendaView: View {
  let model: Model
  @State private var days: [(day: Date, items: [Item])] = []
  @State private var problem: String?

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { t in
      VStack(spacing: 0) {
        Down(core: model.core)
        if let problem { Problem(text: problem) }
        ScrollView {
          LazyVStack(spacing: 0) {
            if days.isEmpty { Empty("Clear") }
            ForEach(Array(days.enumerated()), id: \.element.day) { i, d in
              BoardSection(label: label(d.day), count: d.items.count, first: i == 0) {
                Rule()
                ForEach(d.items) { ItemRow(item: $0, now: t.date) { model.path.append(.event($0.id)) } }
              }
            }
          }
        }
        .refreshable { await load() }
        if let done = model.done { DoneBar(model: model, done: done) }
      }
    }
    .background(SIS.paper)
    .band("Calendar")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          model.making = true
        } label: {
          Image(systemName: "plus")
        }
        .accessibilityLabel("New event")
      }
    }
    .sheet(isPresented: Binding(get: { model.making }, set: { model.making = $0 })) {
      EventSheet(model: model, editing: nil)
        .presentationDetents([.large])
        .presentationCornerRadius(SIS.radius)
    }
    .task(id: model.changes) { await load() }
    .seen(model.core, "agenda")
  }

  private func label(_ day: Date) -> String {
    let cal = Calendar.current
    if cal.isDateInToday(day) { return "Today" }
    if cal.isDateInTomorrow(day) { return "Tomorrow" }
    return day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
  }

  private func load() async {
    let cal = Calendar.current
    let from = cal.startOfDay(for: Date())
    let to = cal.date(byAdding: .day, value: 14, to: from) ?? from
    do {
      let r = try await model.core.call("list", ["from": from.ms, "to": to.ms])
      var seen = Set<String>()
      let items = r["events"].array.compactMap(Item.init).filter { e in
        guard seen.insert("\(e.title)|\(e.start.timeIntervalSince1970)").inserted else { return false }
        return e.end > Date() || cal.isDateInToday(e.start)
      }
      days = Dictionary(grouping: items) { cal.startOfDay(for: $0.start) }
        .map { (day: $0.key, items: $0.value.sorted { ($0.allDay ? 0 : 1, $0.start) < ($1.allDay ? 0 : 1, $1.start) }) }
        .sorted { $0.day < $1.day }
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// An event in the agenda: its time, its title and place, and its marks.
struct ItemRow: View {
  let item: Item
  let now: Date
  let action: (Item) -> Void

  var body: some View {
    RowButton(action: { action(item) }) {
      Text(item.allDay ? "Day" : item.start.formatted(date: .omitted, time: .shortened))
        .font(SIS.data(12)).foregroundStyle(SIS.ink2)
        .frame(width: 64 * SIS.scale, alignment: .leading)
      VStack(alignment: .leading, spacing: 2) {
        Text(item.title.isEmpty ? "Busy" : item.title).lineLimit(1)
        if !item.location.isEmpty {
          Text(item.location).font(SIS.text(12)).foregroundStyle(SIS.ink3).lineLimit(1)
        }
      }
      .padding(.vertical, 6)
      Spacer(minLength: 8)
      if item.needsYou { Hand() }
      if !item.allDay && item.start <= now && item.end > now { Runner() }
    }
  }
}

/// What was just written, and its Undo.
struct DoneBar: View {
  let model: Model
  let done: Model.Done
  @State private var problem: String?

  var body: some View {
    VStack(spacing: 0) {
      Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth)
      HStack(spacing: 10) {
        if done.write.isEmpty { Hand() }
        Text(problem ?? done.text).font(SIS.text(14)).foregroundStyle(SIS.ink).lineLimit(1)
        Spacer(minLength: 8)
        if !done.write.isEmpty {
          Button("Undo") {
            Task {
              do { try await model.undo(done.write) } catch { problem = error.localizedDescription }
            }
          }
          .buttonStyle(KeyStyle())
        }
        Button {
          model.done = nil
        } label: {
          Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
        }
        .buttonStyle(KeyStyle())
        .accessibilityLabel("Close")
      }
      .padding(.horizontal, SIS.inset)
      .padding(.vertical, 10)
    }
    .background(SIS.wash)
  }
}
