import Foundation
import LakeUpdateCore

private final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int] = []
    func append(_ value: Int) { lock.lock(); defer { lock.unlock() }; values.append(value) }
    func snapshot() -> [Int] { lock.lock(); defer { lock.unlock() }; return values }
}

func testArchiveDownload() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    let portFile = directory.appendingPathComponent("port")
    let server = Process()
    server.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    server.arguments = ["python3", URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("download-server.py").path, portFile.path]
    server.standardOutput = FileHandle.nullDevice
    server.standardError = FileHandle.nullDevice
    try server.run()
    defer {
        server.terminate()
        server.waitUntilExit()
        try? FileManager.default.removeItem(at: directory)
    }
    for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: portFile.path) { break }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    let port = try String(contentsOf: portFile, encoding: .utf8)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForResource = 10
    for path in ["length", "chunked"] {
        let log = ProgressLog()
        let file = directory.appendingPathComponent(path)
        let transfer = Task {
            try await ArchiveDownload.download(from: URL(string: "http://127.0.0.1:\(port)/\(path)")!,
                                               to: file, expectedSize: 1024 * 1024, configuration: configuration, changed: { log.append($0) })
        }
        try await Task.sleep(nanoseconds: 500_000_000)
        let intermediate = log.snapshot()
        precondition(intermediate.contains(where: { $0 > 0 && $0 < 99 }), "progress must arrive before the download finishes")
        let response = try await transfer.value
        defer { try? FileManager.default.removeItem(at: file) }
        precondition((response as? HTTPURLResponse)?.statusCode == 200)
        let downloaded = try Data(contentsOf: file)
        precondition(downloaded == Data(repeating: 76, count: 1024 * 1024))
        let values = log.snapshot()
        precondition(values == values.sorted() && Set(values).count == values.count)
        precondition(values.count >= 3 && values.last == 99 && !values.contains(100))
        print("Passed real throttled \(path) download: \(values.count) byte-driven progress events")
    }
    let log = ProgressLog()
    let cancelledFile = directory.appendingPathComponent("cancelled")
    let transfer = Task {
        try await ArchiveDownload.download(from: URL(string: "http://127.0.0.1:\(port)/cancel")!,
                                           to: cancelledFile, expectedSize: 1024 * 1024, configuration: configuration, changed: { log.append($0) })
    }
    try await Task.sleep(nanoseconds: 300_000_000)
    transfer.cancel()
    do {
        _ = try await transfer.value
        preconditionFailure("cancelled download must fail")
    } catch {
        precondition((error as? URLError)?.code == .cancelled || error is CancellationError)
        precondition(!log.snapshot().contains(100))
        precondition(!FileManager.default.fileExists(atPath: cancelledFile.path))
    }
    print("Passed download cancellation: no false completion")
}
