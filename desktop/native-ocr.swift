import Foundation
import Vision
import ImageIO

// stdin/stdout only: no screenshot permissions, no network, no patient temp files.
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          let encoded = request["image"] as? String,
          let data = Data(base64Encoded: encoded), data.count <= 4_000_000,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "OCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid image"])
    }
    let recognition = VNRecognizeTextRequest()
    recognition.recognitionLevel = .accurate
    recognition.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    recognition.usesLanguageCorrection = false
    let orientation = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])?[kCGImagePropertyOrientation] as? UInt32 ?? 1
    try VNImageRequestHandler(cgImage: image, orientation: CGImagePropertyOrientation(rawValue: orientation) ?? .up, options: [:]).perform([recognition])
    let lines = (recognition.results ?? []).compactMap { observation -> [String: Any]? in
        guard let value = observation.topCandidates(1).first else { return nil }
        return ["text": value.string, "confidence": value.confidence]
    }
    let output = try JSONSerialization.data(withJSONObject: ["lines": lines, "engine": "Apple Vision", "local": true])
    FileHandle.standardOutput.write(output)
} catch {
    FileHandle.standardError.write(Data("Local OCR failed: \(error.localizedDescription)".utf8))
    exit(1)
}
