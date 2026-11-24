// The barcode reader's source, compiled on the Mac that runs it (barcodes.ts): Vision reads every
// code in an image, or in each page of a PDF drawn at 300 dpi. It needs no permission. A raw string
// keeps its backslashes; it holds no backtick and no dollar-brace.
export const source = String.raw`import AppKit
import Foundation
import ImageIO
import PDFKit
import Vision

struct Failure: Error { let message: String }

func emit(_ value: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("null".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func codes(_ image: CGImage, _ page: Int?, _ orientation: CGImagePropertyOrientation = .up) throws -> [[String: Any]] {
  let request = VNDetectBarcodesRequest()
  try VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:]).perform([request])
  return (request.results ?? []).map { o in
    var c: [String: Any] = [
      "symbology": o.symbology.rawValue,
      "box": [o.boundingBox.minX, 1 - o.boundingBox.maxY, o.boundingBox.width, o.boundingBox.height],
    ]
    if let s = o.payloadStringValue { c["text"] = s }
    if let p = page { c["page"] = p }
    return c
  }
}

func pageImage(_ page: PDFPage, dpi: CGFloat) -> CGImage? {
  let bounds = page.bounds(for: .mediaBox)
  let scale = dpi / 72
  let width = Int(bounds.width * scale), height = Int(bounds.height * scale)
  guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { return nil }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}

func read(_ path: String) throws -> Any {
  let url = URL(fileURLWithPath: path)
  let head = (try? FileHandle(forReadingFrom: url).read(upToCount: 5)) ?? nil
  if head == Data("%PDF-".utf8), let doc = PDFDocument(url: url), doc.pageCount > 0 {
    var found: [[String: Any]] = []
    for i in 0..<min(doc.pageCount, 30) {
      guard let page = doc.page(at: i), let image = pageImage(page, dpi: 300) else { continue }
      found += try codes(image, i + 1)
    }
    return ["pages": doc.pageCount, "codes": found]
  }
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldAllowFloat: false] as CFDictionary)
  else { throw Failure(message: "Not an image or PDF") }
  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
  let raw = properties?[kCGImagePropertyOrientation] as? UInt32 ?? 1
  let orientation = CGImagePropertyOrientation(rawValue: raw) ?? .up
  return ["width": image.width, "height": image.height, "codes": try codes(image, nil, orientation)]
}

let argv = CommandLine.arguments
do {
  guard argv.count > 1 else { throw Failure(message: "barcodes <path>") }
  emit(try read(argv[1]))
} catch let e as Failure {
  emit(["error": e.message])
  exit(1)
} catch {
  emit(["error": error.localizedDescription])
  exit(1)
}
`
