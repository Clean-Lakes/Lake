import Foundation
import AVFoundation
import AppKit

guard CommandLine.arguments.count == 5,
      let count = Int(CommandLine.arguments[3]),
      let maxDimension = Int(CommandLine.arguments[4]),
      count > 0, count <= 4, maxDimension >= 64, maxDimension <= 768 else {
  fputs("invalid video arguments\n", stderr)
  exit(2)
}

let videoURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let asset = AVURLAsset(url: videoURL)
guard let durationTime = try? await asset.load(.duration),
      let videoTracks = try? await asset.loadTracks(withMediaType: .video) else {
  fputs("video cannot be decoded\n", stderr)
  exit(3)
}
let duration = CMTimeGetSeconds(durationTime)
guard duration.isFinite, duration > 0, duration <= 300,
      !videoTracks.isEmpty else {
  fputs("video duration or track is invalid\n", stderr)
  exit(3)
}

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.maximumSize = CGSize(width: maxDimension, height: maxDimension)
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)

for index in 0..<count {
  let seconds = duration * Double(index + 1) / Double(count + 1)
  let time = CMTime(seconds: seconds, preferredTimescale: 600)
  do {
    let image = try generator.copyCGImage(at: time, actualTime: nil)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.72]),
          jpeg.count > 0, jpeg.count <= 1048576 else { throw NSError(domain: "LakeVideo", code: 4) }
    let target = outputURL.appendingPathComponent(String(format: "frame-%02d.jpg", index + 1))
    try jpeg.write(to: target, options: .atomic)
  } catch {
    fputs("video frame decode failed\n", stderr)
    exit(4)
  }
}
print(duration)
