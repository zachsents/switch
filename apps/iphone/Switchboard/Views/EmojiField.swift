import SwiftUI
import UIKit

/// Any emoji as a reaction, chosen on the system's emoji keyboard: a field out of sight takes the
/// focus with that keyboard up, and the emoji typed into it is the reaction. Open while `open` is.
struct EmojiField: UIViewRepresentable {
  @Binding var open: Bool
  let onPick: (Reaction) -> Void

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> Field {
    let field = Field()
    field.tintColor = .clear
    field.delegate = context.coordinator
    field.addTarget(context.coordinator, action: #selector(Coordinator.typed(_:)), for: .editingChanged)
    return field
  }

  func updateUIView(_ field: Field, context: Context) {
    context.coordinator.open = $open
    context.coordinator.onPick = onPick
    if open, !field.isFirstResponder {
      DispatchQueue.main.async { field.becomeFirstResponder() }
    } else if !open, field.isFirstResponder {
      field.resignFirstResponder()
    }
  }

  /// A text field whose keyboard is the emoji one.
  final class Field: UITextField {
    override var textInputContextIdentifier: String? { "emoji" }
    override var textInputMode: UITextInputMode? {
      UITextInputMode.activeInputModes.first { $0.primaryLanguage == "emoji" } ?? super.textInputMode
    }
  }

  @MainActor final class Coordinator: NSObject, UITextFieldDelegate {
    var open: Binding<Bool>?
    var onPick: ((Reaction) -> Void)?

    @objc func typed(_ field: UITextField) {
      let text = field.text ?? ""
      field.text = ""
      guard let r = Reaction(rawValue: text), r.tapback == nil else { return }
      onPick?(r)
      open?.wrappedValue = false
    }

    func textFieldDidEndEditing(_ field: UITextField) {
      open?.wrappedValue = false
    }
  }
}
