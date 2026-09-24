import Foundation
import PDFKit
import Vision
import AppKit
do {
    let request = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
    guard let path = request["path"] as? String, let pdf = PDFDocument(url: URL(fileURLWithPath: path)), pdf.pageCount <= 300 else { throw NSError(domain: "PDF", code: 1, userInfo: [NSLocalizedDescriptionKey: "PDF 无效或超过 300 页"]) }
    var pages: [[String: Any]] = []
    var count = 0
    for index in 0..<pdf.pageCount {
        guard let page = pdf.page(at: index) else { continue }
        var text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var ocr = false
        if text.count < 10 {
            let bounds = page.bounds(for: .mediaBox)
            let scale = min(2.5, 1800 / max(bounds.width, bounds.height))
            let image = page.thumbnail(of: NSSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
            if let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                let r = VNRecognizeTextRequest()
                r.recognitionLevel = .accurate
                r.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
                r.usesLanguageCorrection = false
                try VNImageRequestHandler(cgImage: cg).perform([r])
                text = (r.results ?? []).compactMap { $0.topCandidates(1).first }.map { $0.string + ($0.confidence < 0.7 ? " [文字识别待核对]" : "") }.joined(separator: "\n")
                ocr = true
            }
        }
        count += text.count
        guard count <= 480000 else { throw NSError(domain: "PDF", code: 2, userInfo: [NSLocalizedDescriptionKey: "PDF 文字超过容量，请按章节拆分后导入"]) }
        pages.append(["page": index + 1, "text": text, "ocr": ocr])
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["pages": pages]))
} catch {
    FileHandle.standardError.write(Data(error.localizedDescription.utf8)); exit(1)
}
