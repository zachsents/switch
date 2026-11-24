import UIKit

/// How wide a chart's small words are drawn, to keep room for them.
enum ChartText {
  static func width(_ text: String) -> CGFloat {
    let font = UIFont.monospacedDigitSystemFont(ofSize: SIS.Size.label * SIS.scale, weight: .regular)
    return ceil((text as NSString).size(withAttributes: [.font: font]).width)
  }
}
