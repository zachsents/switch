import SwiftUI
import UIKit

/// What can be done to a space, in its ⋯ menu and a long-press on its line: rename, split off its
/// latest exchange, move it, copy its link, archive or unarchive it. `open` is whether it's the page
/// in front, which archiving leaves for the space above.
struct SpaceMenu: View {
  let phone: Phone
  let id: String
  @Binding var renaming: Bool
  let open: Bool

  private var brain: Brain { phone.brain }

  var body: some View {
    let space = brain.spaces[id]
    if id != HOME {
      Button("Rename", systemImage: "pencil") { renaming = true }
    }
    Button("Split Off", systemImage: "arrow.up.right.square") {
      let made = "split-\(UUID().uuidString.prefix(4).lowercased())"
      Task {
        try? await phone.command("space.split", ["id": .string(made), "from": .string(id)])
        phone.open(.space(made))
      }
    }
    if id != HOME {
      let inside = brain.subtree(id)
      Menu("Move To", systemImage: "folder") {
        Button("Top Level") { move(nil) }
        ForEach(brain.warmest.filter { !inside.contains($0.id) && $0.id != HOME && $0.id != space?.parent }) { x in
          Button(x.name) { move(x.id) }
        }
      }
    }
    Button("Copy Link", systemImage: "link") {
      UIPasteboard.general.string = Phone.link(id)
    }
    if id != HOME {
      if space?.archived == true {
        Button("Unarchive", systemImage: "tray.and.arrow.up") {
          Task { try? await phone.command("space.unarchive", ["id": .string(id)]) }
        }
      } else {
        Button("Archive", systemImage: "archivebox", role: .destructive) {
          Task {
            try? await phone.command("space.archive", ["id": .string(id)])
            if open { phone.open(.space(space?.parent ?? HOME)) }
          }
        }
      }
    }
  }

  private func move(_ to: String?) {
    Task { try? await phone.command("space.move", ["id": .string(id), "parent": to.map { .string($0) } ?? .null]) }
  }
}

/// The rename alert's field and keys: Rename keeps the words, Cancel the old name.
struct RenameAlert: View {
  let phone: Phone
  let id: String
  @State private var name = ""

  var body: some View {
    TextField("Name", text: $name)
      .onAppear { name = phone.brain.spaces[id]?.name ?? "" }
    Button("Cancel", role: .cancel) {}
    Button("Rename") {
      let words = name.trimmingCharacters(in: .whitespaces)
      guard !words.isEmpty else { return }
      Task { try? await phone.command("space.rename", ["id": .string(id), "name": .string(words)]) }
    }
  }
}
