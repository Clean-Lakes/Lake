import Foundation
import CryptoKit

public struct Version: Comparable, Equatable {
    public let parts: [Int]
    public init?(_ value: String) {
        let text = value.hasPrefix("v") ? String(value.dropFirst()) : value
        let fields = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (3...4).contains(fields.count), fields.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
              fields.allSatisfy({ $0.count == 1 || !$0.hasPrefix("0") }) else { return nil }
        let numbers = fields.compactMap { Int($0) }
        guard numbers.count == fields.count else { return nil }
        // Three-field versions fill the fourth slot with 0 so 0.3.8.1 sorts
        // after 0.3.8 and before 0.3.9, matching the Windows Go client.
        parts = numbers + Array(repeating: 0, count: 4 - numbers.count)
    }
    public static func < (lhs: Version, rhs: Version) -> Bool { lhs.parts.lexicographicallyPrecedes(rhs.parts) }
}

public struct ReleaseAsset: Decodable {
    public let name: String
    public let size: Int64
    public let browser_download_url: String
    public var url: URL? {
        guard let url = URL(string: browser_download_url), url.scheme == "https", url.host == "github.com",
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              url.path.hasPrefix("/Clean-Lakes/Lake/releases/download/") else { return nil }
        return url
    }
}
public struct Release: Decodable {
    public let tag_name: String
    public let target_commitish: String
    public let draft: Bool
    public let prerelease: Bool
    public let assets: [ReleaseAsset]
    public let body: String?
}
public struct Update {
    public let version: String
    public let archive: ReleaseAsset
    public let checksum: ReleaseAsset
    public let releaseNotes: String
}

public enum ReleasePolicy {
    public static func latest(_ releases: [Release], current: String, architecture: String) -> Update? {
        guard let installed = Version(current), ["arm64", "x86_64"].contains(architecture) else { return nil }
        return releases.compactMap { release -> Update? in
            guard !release.draft, !release.prerelease, release.target_commitish == "master",
                  let version = Version(release.tag_name), version > installed else { return nil }
            let number = release.tag_name.hasPrefix("v") ? String(release.tag_name.dropFirst()) : release.tag_name
            // The native Go client uses its own asset family; legacy Electron ZIPs are incompatible.
            let name = "Lake-\(number)-macos-\(architecture).zip"
            guard let archive = release.assets.first(where: { $0.name == name }),
                  let checksum = release.assets.first(where: { $0.name == name + ".sha256" }),
                  archive.size > 0, archive.size <= 512 * 1024 * 1024,
                  checksum.size > 0, checksum.size <= 4096,
                  archive.url?.lastPathComponent == name,
                  checksum.url?.lastPathComponent == name + ".sha256",
                  archive.url?.deletingLastPathComponent().lastPathComponent == release.tag_name,
                  checksum.url?.deletingLastPathComponent().lastPathComponent == release.tag_name else { return nil }
            return Update(version: number, archive: archive, checksum: checksum, releaseNotes: release.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        }.max(by: { Version($0.version)! < Version($1.version)! })
    }

    public static func verifyChecksum(_ data: Data, archive: URL, name: String) throws {
        guard let line = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            throw UpdateError.invalidChecksum
        }
        let fields = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard fields.count == 2, fields[1] == Substring(name), fields[0].count == 64,
              fields[0].allSatisfy({ $0.isASCII && $0.isHexDigit }) else { throw UpdateError.invalidChecksum }
        let file = try FileHandle(forReadingFrom: archive)
        defer { try? file.close() }
        var hash = SHA256()
        while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
        let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == fields[0].lowercased() else { throw UpdateError.invalidChecksum }
    }

    public static func validateArchivePaths(_ listing: String) throws {
        let paths = listing.split(separator: "\n")
        guard !paths.isEmpty, paths.count <= 20000 else { throw UpdateError.invalidArchive }
        for entry in paths {
            let path = String(entry)
            guard path == "Lake.app/" || path.hasPrefix("Lake.app/"),
                  !path.contains("\\"), !path.contains("\r"),
                  !path.split(separator: "/", omittingEmptySubsequences: false).contains("..") else {
                throw UpdateError.invalidArchive
            }
        }
    }
}

public enum UpdateError: LocalizedError {
    case invalidChecksum, invalidArchive, message(String)
    public var errorDescription: String? {
        switch self {
        case .invalidChecksum: return "安装包校验失败，请重新检测更新。"
        case .invalidArchive: return "安装包格式不兼容。"
        case .message(let text): return text
        }
    }
}
