import Foundation
import Darwin

/// Deletes only Lake-owned obsolete bundles and completed update jobs.
public enum UpdateCleanup {
    @discardableResult public static func removeObsoleteBackups(target: URL, currentVersion: String) throws -> Int {
        guard let current = Version(currentVersion) else { return 0 }
        let app = target.resolvingSymlinksInPath().standardizedFileURL
        guard let identity = bundleInfo(app)?["CFBundleIdentifier"] as? String,
              ["com.cleanlakes.lake.desktop", "com.cleanlakes.lake.desktop.dev"].contains(identity) else { return 0 }
        let parent = app.deletingLastPathComponent()
        let name = identity.hasSuffix(".dev") ? "Lake Dev" : "Lake"
        let candidates = try FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: [.isSymbolicLinkKey])
        var removed = 0
        for candidate in candidates {
            let leaf = candidate.lastPathComponent
            guard leaf.hasSuffix(".app"), leaf.hasPrefix(name + ".backup-") || leaf.hasPrefix(name + ".backup."),
                  candidate.standardizedFileURL != app,
                  try candidate.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true,
                  let info = bundleInfo(candidate), info["CFBundleIdentifier"] as? String == identity,
                  let old = Version(info["CFBundleShortVersionString"] as? String ?? ""), old <= current else { continue }
            try FileManager.default.removeItem(at: candidate)
            removed += 1
        }
        return removed
    }

    @discardableResult public static func removeCompletedDownloads(directory: URL, currentVersion: String, now: Date = Date()) throws -> Int {
        guard let current = Version(currentVersion), FileManager.default.fileExists(atPath: directory.path) else { return 0 }
        guard try directory.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { return 0 }
        let children = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey])
        let known: Set<String> = ["complete", "ready", "ready.pid", "ready.backend", "install.log", "install-update.sh", "update.zip", "unpacked"]
        var removed = 0
        for job in children {
            guard UUID(uuidString: job.lastPathComponent) != nil,
                  try job.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true,
                  !FileManager.default.fileExists(atPath: job.appendingPathComponent("error").path) else { continue }
            let complete = job.appendingPathComponent("complete")
            let ready = job.appendingPathComponent("ready")
            var receipt = smallText(complete)
            if receipt == nil {
                // Legacy helpers wrote only ready; wait beyond the complete rollback window.
                let values = try? ready.resourceValues(forKeys: [.contentModificationDateKey])
                guard let modified = values?.contentModificationDate, now.timeIntervalSince(modified) > 600,
                      let pidText = smallText(job.appendingPathComponent("ready.pid")), let pid = Int32(pidText), pid > 0,
                      kill(pid, 0) != 0, errno == ESRCH else { continue }
                receipt = smallText(ready)
            }
            guard let receipt, let old = Version(receipt), old <= current else { continue }
            let files = try FileManager.default.contentsOfDirectory(at: job, includingPropertiesForKeys: [.isSymbolicLinkKey])
            guard files.allSatisfy({ known.contains($0.lastPathComponent) && (try? $0.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true }) else { continue }
            try FileManager.default.removeItem(at: job)
            removed += 1
        }
        return removed
    }

    private static func smallText(_ url: URL) -> String? {
        guard let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .fileSizeKey]),
              values.isSymbolicLink != true, let size = values.fileSize, size <= 64,
              let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func bundleInfo(_ app: URL) -> [String: Any]? {
        let file = app.appendingPathComponent("Contents/Info.plist")
        guard file.resolvingSymlinksInPath().path.hasPrefix(app.resolvingSymlinksInPath().path + "/"),
              let metadata = try? file.resourceValues(forKeys: [.fileSizeKey]), let size = metadata.fileSize, size < 1024 * 1024,
              let data = try? Data(contentsOf: file), data.count < 1024 * 1024 else { return nil }
        return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    }
}
