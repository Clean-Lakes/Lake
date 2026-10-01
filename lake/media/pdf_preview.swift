import Foundation
import PDFKit
import AppKit

guard CommandLine.arguments.count == 3 else { exit(2) }
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard let document = PDFDocument(url: source), document.pageCount > 0,
      let first = document.page(at: 0) else {
  fputs("PDF cannot be decoded\n", stderr)
  exit(3)
}
let thumbnail = first.thumbnail(of: CGSize(width: 768, height: 768), for: .mediaBox)
guard let tiff = thumbnail.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.72]),
      jpeg.count > 0, jpeg.count <= 1048576 else {
  fputs("PDF preview image failed\n", stderr)
  exit(4)
}
try jpeg.write(to: output.appendingPathComponent("preview.jpg"), options: .atomic)

var text = ""
var truncated = false
for index in 0..<min(document.pageCount, 10) {
  let pageText = document.page(at: index)?.string ?? ""
  let addition = "[第 \(index + 1) 页]\n" + pageText + "\n"
  if text.utf8.count + addition.utf8.count > 65536 {
    let remaining = max(0, 65536 - text.utf8.count)
    text += String(decoding: addition.utf8.prefix(remaining), as: UTF8.self)
    truncated = true
    break
  }
  text += addition
}
let metadata: [String: Any] = ["pages": document.pageCount, "text": text, "truncated": truncated || document.pageCount > 10]
let data = try JSONSerialization.data(withJSONObject: metadata)
try data.write(to: output.appendingPathComponent("preview.json"), options: .atomic)
