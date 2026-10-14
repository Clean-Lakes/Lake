import Foundation
import Darwin
import LakeUpdateCore

func testUpdateCleanup() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    func app(_ name: String, version: String = "0.3.0", identity: String = "com.cleanlakes.lake.desktop") throws -> URL {
        let url = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": identity, "CFBundleShortVersionString": version], format: .xml, options: 0)
        try data.write(to: url.appendingPathComponent("Contents/Info.plist"))
        return url
    }
    let target = try app("Lake.app", version: "0.4.0")
    let obsolete = try app("Lake.backup-0.3.0-test.app")
    let legacy = try app("Lake.backup.20261014-test.app")
    let foreign = try app("Lake.backup-foreign.app", identity: "com.example.other")
    let future = try app("Lake.backup-future.app", version: "9.0.0")
    let unrelated = try app("Manual Lake.app")
    let linked = root.appendingPathComponent("Lake.backup-link.app")
    try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: unrelated)
    let removedApps = try UpdateCleanup.removeObsoleteBackups(target: target, currentVersion: "0.4.0")
    precondition(removedApps == 2)
    precondition(!FileManager.default.fileExists(atPath: obsolete.path) && !FileManager.default.fileExists(atPath: legacy.path))
    for url in [target, foreign, future, unrelated, linked] { precondition(FileManager.default.fileExists(atPath: url.path)) }
    let downloads = root.appendingPathComponent("updates")
    try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: false)
    func job(_ complete: Bool, unknown: Bool = false, failed: Bool = false) throws -> URL {
        let url = downloads.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        try Data("synthetic zip".utf8).write(to: url.appendingPathComponent("update.zip"))
        if complete { try Data("0.4.0".utf8).write(to: url.appendingPathComponent("complete")) }
        if unknown { try Data("keep".utf8).write(to: url.appendingPathComponent("user.txt")) }
        if failed { try Data("failed".utf8).write(to: url.appendingPathComponent("error")) }
        return url
    }
    let completed = try job(true), pending = try job(false), extra = try job(true, unknown: true), failed = try job(true, failed: true)
    let legacyDone = try job(false), legacyActive = try job(false)
    let exited = Process(); exited.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try exited.run(); let exitedPID = exited.processIdentifier; exited.waitUntilExit()
    for (url, pid) in [(legacyDone, exitedPID), (legacyActive, getpid())] {
        try Data("0.4.0".utf8).write(to: url.appendingPathComponent("ready"))
        try Data(String(pid).utf8).write(to: url.appendingPathComponent("ready.pid"))
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-3600)], ofItemAtPath: url.appendingPathComponent("ready").path)
    }
    let removedJobs = try UpdateCleanup.removeCompletedDownloads(directory: downloads, currentVersion: "0.4.0")
    precondition(removedJobs == 2)
    precondition(!FileManager.default.fileExists(atPath: completed.path))
    precondition(!FileManager.default.fileExists(atPath: legacyDone.path))
    for url in [pending, extra, failed, legacyActive] { precondition(FileManager.default.fileExists(atPath: url.path)) }
    print("Passed update cleanup: success-only packages/backups, version/identity/symlink boundaries, active/error jobs preserved")
}
