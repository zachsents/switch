import SwiftUI

/// The find bar, the chat's top cell: the words, which match of how many, and keys back and forward
/// in time. The match is the chat's `chatAt`, brought into view and ringed.
struct ChatFind: View {
  let phone: Phone
  let space: String
  @State private var query = ""
  /// The brain's matches for `settled`, oldest first.
  @State private var seqs: [Int] = []
  @State private var settled = ""
  /// Which match is current, counting from the latest.
  @State private var n = 0
  @FocusState private var focused: Bool

  private func show() {
    phone.chatAt[space] = seqs.isEmpty ? nil : seqs[seqs.count - 1 - n]
  }

  private func step(_ by: Int) {
    guard !seqs.isEmpty else { return }
    n = (n + by + seqs.count) % seqs.count
    show()
  }

  var body: some View {
    let words = query.trimmingCharacters(in: .whitespaces)
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        TextField("Find", text: $query)
          .font(SIS.text(16))
          .foregroundStyle(SIS.ink)
          .focused($focused)
          .submitLabel(.search)
          .onSubmit { step(1) }
        if !words.isEmpty, settled == words {
          Text(seqs.isEmpty ? "None" : "\(n + 1)/\(seqs.count)").font(SIS.text(12)).foregroundStyle(SIS.ink3)
        }
        Button { step(1) } label: { Image(systemName: "chevron.up") }
          .accessibilityLabel("Earlier")
          .disabled(seqs.isEmpty)
        Button { step(-1) } label: { Image(systemName: "chevron.down") }
          .accessibilityLabel("Later")
          .disabled(seqs.isEmpty)
        Button {
          phone.chatAt[space] = nil
          phone.findingIn = nil
        } label: {
          Image(systemName: "xmark")
        }
        .accessibilityLabel("Close")
      }
      .foregroundStyle(SIS.ink2)
      .padding(.horizontal, SIS.inset)
      .frame(height: 44)
      Hairline()
    }
    .background(SIS.paper)
    .onAppear { focused = true }
    .task(id: words) {
      guard !words.isEmpty else {
        seqs = []
        settled = ""
        return
      }
      try? await Task.sleep(for: .milliseconds(150))
      guard !Task.isCancelled else { return }
      let found = await phone.find(words, in: space)
      guard !Task.isCancelled else { return }
      seqs = found
      settled = words
      n = 0
      show()
    }
  }
}
