// The picture reader's source, compiled on the Mac that runs it (pictures.ts). The picture comes on
// stdin, upright as its orientation says, and never touches the disk here:
//   read        Vision's text, accurate, with no language correction (a key isn't a word): each line
//               and each of its words' UTF-16 range and box, [x, y, w, h] of the picture, top-left.
//   fill <json> the picture with those boxes ([[x, y, w, h], …]) filled solid, on stdout, in its own
//               format when ImageIO writes it, else PNG.
// It needs no permission. A raw string keeps its backslashes; it holds no backtick and no dollar-brace.
export const source = String.raw`import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct Failure: Error { let message: String }

func emit(_ value: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [])) ?? Data("null".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func upright(_ data: Data) throws -> (CGImage, CFString) {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
        let type = CGImageSourceGetType(source),
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
    throw Failure(message: "Not a picture")
  }
  let w = props[kCGImagePropertyPixelWidth] as? Int ?? 0
  let h = props[kCGImagePropertyPixelHeight] as? Int ?? 0
  let options: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceThumbnailMaxPixelSize: max(w, h, 1),
  ]
  guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
    throw Failure(message: "Not a picture")
  }
  return (image, type)
}

func read(_ image: CGImage) throws -> [[String: Any]] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
  let word = try NSRegularExpression(pattern: "\\S+")
  return (request.results ?? []).compactMap { o -> [String: Any]? in
    guard let top = o.topCandidates(1).first else { return nil }
    let text = top.string
    let ns = text as NSString
    let words: [[Any]] = word.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
      guard let range = Range(m.range, in: text),
            let box = try? top.boundingBox(for: range)?.boundingBox else { return nil }
      return [m.range.location, m.range.location + m.range.length, box.minX, 1 - box.maxY, box.width, box.height]
    }
    return ["text": text, "words": words]
  }
}

func fill(_ image: CGImage, _ type: CFString, _ boxes: [[Double]]) throws -> Data {
  let w = image.width, h = image.height
  guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw Failure(message: "Can't draw it")
  }
  context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
  let pad = 0.15
  for b in boxes where b.count == 4 {
    let bw = b[2] * Double(w), bh = b[3] * Double(h)
    let x = b[0] * Double(w) - bh * pad, top = b[1] * Double(h) - bh * pad
    context.fill(CGRect(x: x, y: Double(h) - top - bh * (1 + 2 * pad), width: bw + 2 * bh * pad, height: bh * (1 + 2 * pad)))
  }
  guard let filled = context.makeImage() else { throw Failure(message: "Can't draw it") }
  let writable = (CGImageDestinationCopyTypeIdentifiers() as? [String] ?? []).contains(type as String)
  let out = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(out, writable ? type : UTType.png.identifier as CFString, 1, nil) else {
    throw Failure(message: "Can't write it")
  }
  CGImageDestinationAddImage(dest, filled, nil)
  guard CGImageDestinationFinalize(dest) else { throw Failure(message: "Can't write it") }
  return out as Data
}

let args = CommandLine.arguments
do {
  let (image, type) = try upright(FileHandle.standardInput.readDataToEndOfFile())
  if args.count > 2, args[1] == "fill" {
    let boxes = (try JSONSerialization.jsonObject(with: Data(args[2].utf8)) as? [[Double]]) ?? []
    FileHandle.standardOutput.write(try fill(image, type, boxes))
  } else {
    emit(["width": image.width, "height": image.height, "lines": try read(image)])
  }
} catch let f as Failure {
  emit(["error": f.message])
  exit(1)
} catch {
  emit(["error": error.localizedDescription])
  exit(1)
}
`
