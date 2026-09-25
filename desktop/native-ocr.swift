import Foundation
import Vision
import ImageIO
import UniformTypeIdentifiers

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
    var recognizedImage = image
    if let region = request["region"] as? [String: Double],
       let x = region["x"], let y = region["y"], let w = region["width"], let h = region["height"] {
        guard x >= 0, y >= 0, w > 0, h > 0, x + w <= 1.000001, y + h <= 1.000001,
              let cropped = image.cropping(to: CGRect(x: x * Double(image.width), y: y * Double(image.height), width: w * Double(image.width), height: h * Double(image.height))) else {
            throw NSError(domain: "OCR", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid region"])
        }
        recognizedImage = cropped
    }
    let recognition = VNRecognizeTextRequest()
    recognition.recognitionLevel = .accurate
    recognition.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    recognition.usesLanguageCorrection = false
    let orientation = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])?[kCGImagePropertyOrientation] as? UInt32 ?? 1
    try VNImageRequestHandler(cgImage: recognizedImage, orientation: CGImagePropertyOrientation(rawValue: orientation) ?? .up, options: [:]).perform([recognition])
    let lines = (recognition.results ?? []).compactMap { observation -> [String: Any]? in
        guard let value = observation.topCandidates(1).first else { return nil }
        let r = observation.boundingBox
        return ["text": value.string, "confidence": value.confidence, "box": ["x": r.minX, "y": 1 - r.maxY, "width": r.width, "height": r.height]]
    }
    var result: [String: Any] = ["lines": lines, "engine": "Apple Vision", "local": true, "width": recognizedImage.width, "height": recognizedImage.height]
    if request["includeImage"] as? Bool == true {
        let buffer = NSMutableData()
        if let destination = CGImageDestinationCreateWithData(buffer, UTType.png.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(destination, recognizedImage, nil)
            if CGImageDestinationFinalize(destination) { result["image"] = buffer.base64EncodedString() }
        }
    }
    let output = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(output)
} catch {
    FileHandle.standardError.write(Data("Local OCR failed: \(error.localizedDescription)".utf8))
    exit(1)
}
