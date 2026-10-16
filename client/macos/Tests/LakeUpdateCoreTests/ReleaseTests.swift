import Foundation
import CryptoKit
import LakeUpdateCore

private func XCTAssertTrue(_ value: Bool) { precondition(value, "expected true") }
private func XCTAssertEqual<T: Equatable>(_ lhs: T, _ rhs: T) { precondition(lhs == rhs, "values differ") }
private func XCTAssertNil<T>(_ value: T?, _ message: String = "expected nil") { precondition(value == nil, message) }
private func XCTAssertThrowsError<T>(_ expression: @autoclosure () throws -> T) {
    do { _ = try expression() } catch { return }
    preconditionFailure("expected error")
}

final class ReleaseTests {
    func release(_ version: String = "0.4.0", branch: String = "master", arch: String = "arm64", prerelease: Bool = false, draft: Bool = false) throws -> Release {
        let name = "Lake-\(version)-macos-\(arch).zip"
        let base = "https://github.com/Clean-Lakes/Lake/releases/download/v\(version)/"
        let data = try JSONSerialization.data(withJSONObject: ["tag_name": "v" + version, "target_commitish": branch,
            "prerelease": prerelease, "draft": draft, "assets": [
                ["name": name, "size": 100, "browser_download_url": base + name],
                ["name": name + ".sha256", "size": 120, "browser_download_url": base + name + ".sha256"]]])
        return try JSONDecoder().decode(Release.self, from: data)
    }
    func testMasterStableArchitectureAndOrdering() throws {
        let releases = try [release("0.5.0", branch: "main"), release("0.6.0", prerelease: true),
            release("0.7.0", draft: true), release("0.8.0", arch: "x86_64"), release("0.4.0"), release("0.3.1")]
        XCTAssertEqual(ReleasePolicy.latest(releases, current: "0.3.0", architecture: "arm64")?.version, "0.4.0")
        XCTAssertNil(ReleasePolicy.latest(releases, current: "0.4.0", architecture: "arm64"))
        XCTAssertEqual(ReleasePolicy.latest([try release("0.3.8.1")], current: "0.3.8", architecture: "arm64")?.version, "0.3.8.1")
        XCTAssertNil(ReleasePolicy.latest([try release("0.3.8.1")], current: "0.3.8.1", architecture: "arm64"))
        XCTAssertEqual(ReleasePolicy.latest(releases, current: "0.3.0", architecture: "x86_64")?.version, "0.8.0")
        XCTAssertNil(ReleasePolicy.latest(releases, current: "0.3.0", architecture: "unknown"))
    }
    func testReleaseNotesStayWithSelectedVersion() throws {
        let original = try release("0.4.0")
        var object = try JSONSerialization.jsonObject(with: JSONEncoderForRelease(original)) as! [String: Any]
        object["body"] = "  ## 更新公告\n- 一键打开终端\n- 中文菜单  "
        let releaseWithNotes = try JSONDecoder().decode(Release.self, from: JSONSerialization.data(withJSONObject: object))
        let selected = ReleasePolicy.latest([releaseWithNotes], current: "0.3.0", architecture: "arm64")
        XCTAssertEqual(selected?.releaseNotes, "## 更新公告\n- 一键打开终端\n- 中文菜单")
        XCTAssertEqual(ReleasePolicy.latest([original], current: "0.3.0", architecture: "arm64")?.releaseNotes, "")
    }
    func testVersionsRejectNonStableAndCompareNumerically() {
        XCTAssertTrue(Version("0.10.0")! > Version("0.9.0")!)
        XCTAssertEqual(Version("v1.2.3"), Version("1.2.3"))
        XCTAssertEqual(Version("1.2.3.0"), Version("1.2.3"))
        XCTAssertTrue(Version("0.3.8.1")! > Version("0.3.8")!)
        XCTAssertTrue(Version("0.3.8.2")! > Version("0.3.8.1")!)
        XCTAssertTrue(Version("0.3.9")! > Version("0.3.8.1")!)
        for text in ["1.2", "1.2.3-beta", "1.2.3+build", "01.2.3", "1.-2.3", "１.2.3", "1.2.3.4.5", "1.2.3."] {
            XCTAssertNil(Version(text), text)
        }
    }
    func testAssetURLBoundary() throws {
        for url in ["http://github.com/Clean-Lakes/Lake/releases/download/v1/a.zip",
                    "https://github.com.evil.test/Clean-Lakes/Lake/releases/download/v1/a.zip",
                    "https://github.com/another/repo/releases/download/v1/a.zip",
                    "https://user@github.com/Clean-Lakes/Lake/releases/download/v1/a.zip"] {
            let data = try JSONSerialization.data(withJSONObject: ["name": "a.zip", "size": 1, "browser_download_url": url])
            XCTAssertNil(try JSONDecoder().decode(ReleaseAsset.self, from: data).url)
        }
        let good = try release()
        var object = try JSONSerialization.jsonObject(with: JSONEncoderForRelease(good)) as! [String: Any]
        object["assets"] = []
        let missing = try JSONDecoder().decode(Release.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(ReleasePolicy.latest([missing], current: "0.3.0", architecture: "arm64"))
    }
    private func JSONEncoderForRelease(_ release: Release) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["tag_name": release.tag_name, "target_commitish": release.target_commitish,
            "prerelease": release.prerelease, "draft": release.draft,
            "assets": release.assets.map { ["name": $0.name, "size": $0.size, "browser_download_url": $0.browser_download_url] as [String: Any] }])
    }
    func testArchiveTraversalAndChecksum() throws {
        try ReleasePolicy.validateArchivePaths("Lake.app/\nLake.app/Contents/MacOS/Lake\n")
        for listing in ["../Lake.app/a", "Lake.app/../../escape", "/Lake.app/a", "Other.app/a", "Lake.app/a\\b", ""] {
            XCTAssertThrowsError(try ReleasePolicy.validateArchivePaths(listing))
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let data = Data("synthetic archive".utf8)
        try data.write(to: file)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        try ReleasePolicy.verifyChecksum(Data("\(digest)  app.zip\n".utf8), archive: file, name: "app.zip")
        XCTAssertThrowsError(try ReleasePolicy.verifyChecksum(Data("\(digest)  other.zip".utf8), archive: file, name: "app.zip"))
        try Data("corrupted".utf8).write(to: file)
        XCTAssertThrowsError(try ReleasePolicy.verifyChecksum(Data("\(digest)  app.zip".utf8), archive: file, name: "app.zip"))
    }
}

@main struct PolicyTests {
    @MainActor static func main() async throws {
        try await testArchiveDownload()
        testDesktopProfiles()
        testUpdateIndicator()
        try testUpdateCleanup()
        let tests = ReleaseTests()
        try tests.testMasterStableArchitectureAndOrdering()
        try tests.testReleaseNotesStayWithSelectedVersion()
        tests.testVersionsRejectNonStableAndCompareNumerically()
        try tests.testAssetURLBoundary()
        try tests.testArchiveTraversalAndChecksum()
        print("Passed 5 release policy groups: master/stable/architecture, versions, asset boundaries, archive/checksum")
    }
}
