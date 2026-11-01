// Local OCR with macOS Vision. Usage: swift scripts/ocr.swift <image>...  -> JSON {path: text} on stdout
import AppKit
import Foundation
import Vision

var out: [String: String] = [:]
for path in CommandLine.arguments.dropFirst() {
    guard let img = NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP"]
    req.usesLanguageCorrection = true
    try? VNImageRequestHandler(cgImage: img).perform([req])
    let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    out[path] = lines.joined(separator: "\n")
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted])
print(String(data: data, encoding: .utf8)!)
