import SwiftUI

/// One event (`get`): when, where, the call and the calendar, who's coming and their answers, and
/// its notes. Its menu moves it (`update`) or cancels it (`cancel`).
struct EventView: View {
  let model: Model
  let id: String
  @State private var event: JSON = .null
  @State private var problem: String?
  @State private var cancelling = false

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem { Problem(text: problem) }
      ScrollView {
        VStack(spacing: 0) {
          if !event.isNull { content }
        }
      }
      if let done = model.done { DoneBar(model: model, done: done) }
    }
    .background(SIS.paper)
    .band("Event")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("Move…", systemImage: "calendar.badge.clock") { model.moving = true }
          Button("Cancel event", systemImage: "xmark.circle", role: .destructive) { cancelling = true }
        } label: {
          Image(systemName: "ellipsis")
        }
        .accessibilityLabel("Actions")
        .disabled(event.isNull)
      }
    }
    .sheet(isPresented: Binding(get: { model.moving && !event.isNull }, set: { model.moving = $0 })) {
      EventSheet(model: model, editing: event["event"])
        .presentationDetents([.large])
        .presentationCornerRadius(SIS.radius)
    }
    .confirmationDialog("Cancel \(event["title"].str)?", isPresented: $cancelling, titleVisibility: .visible) {
      Button("Cancel event", role: .destructive) { Task { await cancel() } }
      Button("Keep", role: .cancel) {}
    }
    .task(id: model.changes) { await load() }
    .seen(model.core, "event", id)
  }

  @ViewBuilder private var content: some View {
    HStack(spacing: 10) {
      Text(event["title"].str).font(SIS.text(SIS.Size.title, weight: .bold)).foregroundStyle(SIS.ink).lineLimit(3)
      Spacer(minLength: 8)
      if event["needsYou"].bool == true { Hand(size: SIS.markLarge) }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 14)
    Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth)
    ForEach(Array(event["fields"].array.enumerated()), id: \.offset) { _, f in
      Field(label: f["label"].str, value: f["value"].str)
    }
    let people = event["people"].array
    if !people.isEmpty {
      BoardSection(label: "People", count: people.count) {
        Rule()
        ForEach(Array(people.enumerated()), id: \.offset) { _, p in
          HStack {
            Text(p["label"].str).font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(1)
            Spacer(minLength: 8)
            Figure(p["value"].str)
          }
          .padding(.horizontal, SIS.inset)
          .frame(minHeight: SIS.row)
          .overlay(alignment: .bottom) { Hairline() }
        }
      }
    }
    let notes = event["event"]["notes"].str
    if !notes.isEmpty {
      BoardSection(label: "Notes", count: nil) {
        Rule()
        Text(notes).font(SIS.text(14)).foregroundStyle(SIS.ink2).textSelection(.enabled)
          .padding(SIS.inset)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private func load() async {
    do {
      event = try await model.core.call("get", ["id": .string(id)])
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }

  private func cancel() async {
    do {
      let r = try await model.core.call("cancel", ["id": .string(id)])
      model.wrote(r, "Cancelled")
      if r["held"].isNull { model.path.removeAll() }
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// A new event (`create`), or an event moved or changed (`update`: a new start keeps its length).
struct EventSheet: View {
  let model: Model
  /// The event as `list` gives it, or nil for a new one.
  let editing: JSON?
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var start = Date()
  @State private var end = Date()
  @State private var place = ""
  @State private var calendar = ""
  @State private var calendars: [(id: String, name: String)] = []
  @State private var problem: String?
  @State private var saving = false
  @State private var given: (start: Date, end: Date, title: String, place: String)?

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let problem { Problem(text: problem) }
        ScrollView {
          VStack(spacing: 0) {
            Cell(label: "Title") {
              TextField("Title", text: $title).font(SIS.text(16)).foregroundStyle(SIS.ink)
            }
            Cell(label: "Starts") {
              // A new start keeps the length.
              DatePicker("", selection: Binding(get: { start }, set: { end = end.addingTimeInterval($0.timeIntervalSince(start)); start = $0 }))
                .labelsHidden()
            }
            Cell(label: "Ends") {
              DatePicker("", selection: $end, in: start...).labelsHidden()
            }
            Cell(label: "Where") {
              TextField("Place", text: $place).font(SIS.text(16)).foregroundStyle(SIS.ink)
            }
            if editing == nil && !calendars.isEmpty {
              Cell(label: "Calendar") {
                Picker("", selection: $calendar) {
                  Text("Default").tag("")
                  ForEach(calendars, id: \.id) { Text($0.name).tag($0.id) }
                }
                .labelsHidden()
              }
            }
          }
        }
      }
      .background(SIS.paper)
      .band(editing == nil ? "New event" : "Move")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button(editing == nil ? "Add" : "Save") { Task { await save() } }
            .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
        }
      }
    }
    .onAppear(perform: fill)
    .task { await loadCalendars() }
    .seen(model.core, editing == nil ? "create" : "move", editing?["id"].str ?? "")
  }

  private func fill() {
    guard let e = editing, given == nil else {
      if editing == nil, given == nil {
        let hour = Calendar.current.nextDate(after: Date(), matching: DateComponents(minute: 0), matchingPolicy: .nextTime) ?? Date()
        start = hour
        end = hour.addingTimeInterval(3600)
        given = (start, end, "", "")
      }
      return
    }
    title = e["title"].str
    start = Item.time(e["start"].str) ?? Date()
    end = Item.time(e["end"].str) ?? start.addingTimeInterval(3600)
    place = e["location"].str
    given = (start, end, title, place)
  }

  private func loadCalendars() async {
    guard editing == nil, let r = try? await model.core.call("status") else { return }
    calendars = r["calendars"].array.filter { $0["writable"].bool == true }.map { (id: $0["id"].str, name: $0["name"].str) }
  }

  private func save() async {
    saving = true
    defer { saving = false }
    do {
      if let e = editing {
        var args: [String: JSON] = ["id": e["id"]]
        if let given {
          if start != given.start { args["start"] = start.ms }
          if end != given.end.addingTimeInterval(start.timeIntervalSince(given.start)) { args["end"] = end.ms }
          if title != given.title { args["title"] = .string(title) }
          if place != given.place { args["location"] = place.isEmpty ? .null : .string(place) }
        }
        let r = try await model.core.call("update", .object(args))
        model.wrote(r, "Moved")
      } else {
        var args: [String: JSON] = ["title": .string(title), "start": start.ms, "end": end.ms]
        if !place.isEmpty { args["location"] = .string(place) }
        if !calendar.isEmpty { args["calendar"] = .string(calendar) }
        let r = try await model.core.call("create", .object(args))
        model.wrote(r, "Added")
      }
      dismiss()
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// A label over what's edited, as a grid cell.
private struct Cell<Content: View>: View {
  let label: String
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label.uppercased()).font(SIS.text(SIS.Size.label, weight: .semibold)).tracking(0.6).foregroundStyle(SIS.ink3)
      content
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, SIS.cellInset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .bottom) { Hairline() }
  }
}
