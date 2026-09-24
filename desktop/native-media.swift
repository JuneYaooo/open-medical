import Foundation
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

@main struct NativeMedia {
    static func main() async {
        do {
            let request = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
            guard let path = request["path"] as? String, FileManager.default.fileExists(atPath: path) else { throw failure("找不到音视频文件") }
            let asset = AVURLAsset(url: URL(fileURLWithPath: path))
            let duration = try await asset.load(.duration).seconds
            guard duration.isFinite, duration > 0, duration <= 7200 else { throw failure("音视频需在 2 小时以内，且时长有效") }
            let audio = try await asset.loadTracks(withMediaType: .audio)
            let video = try await asset.loadTracks(withMediaType: .video)
            let action = request["action"] as? String ?? "inspect"
            var result: [String: Any] = ["duration": duration, "hasAudio": !audio.isEmpty, "hasVideo": !video.isEmpty]
            if action != "inspect" {
                guard let output = request["output"] as? String, let start = request["start"] as? Double, start >= 0, start < duration else { throw failure("媒体片段参数无效") }
                if action == "audio" {
                    guard !audio.isEmpty, let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else { throw failure("没有可读取的音轨") }
                    let length = min(request["length"] as? Double ?? 300, duration - start)
                    exporter.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), duration: CMTime(seconds: length, preferredTimescale: 600))
                    try await exporter.export(to: URL(fileURLWithPath: output), as: .m4a)
                } else if action == "frame" {
                    guard !video.isEmpty else { throw failure("没有可读取的视频轨道") }
                    let generator = AVAssetImageGenerator(asset: asset)
                    generator.appliesPreferredTrackTransform = true
                    generator.maximumSize = CGSize(width: 1440, height: 1080)
                    let frame = try await generator.image(at: CMTime(seconds: start, preferredTimescale: 600))
                    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw failure("无法保存画面") }
                    CGImageDestinationAddImage(dest, frame.image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
                    guard CGImageDestinationFinalize(dest) else { throw failure("画面保存失败") }
                    result["actualTime"] = frame.actualTime.seconds
                } else { throw failure("未知媒体操作") }
            }
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
        } catch {
            FileHandle.standardError.write(Data(error.localizedDescription.utf8))
            exit(1)
        }
    }
    static func failure(_ text: String) -> NSError { NSError(domain: "Media", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}
