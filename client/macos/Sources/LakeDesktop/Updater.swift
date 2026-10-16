import AppKit
import CryptoKit
import LakeUpdateCore
import Security

struct UpdateState: Encodable {
    var status = "idle"
    var currentVersion: String
    var version: String? = nil
    var message = "点击检测 master 发布版本"
    var progress: Int? = nil
    var releaseNotes = ""
    var updateAvailable = false
}

struct InstallContext {
    let pid: Int32
    let home: URL
    let data: URL
}

private func runTool(_ program: String, _ arguments: [String]) throws -> Data {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: program)
    task.arguments = arguments
    let output = Pipe()
    task.standardOutput = output
    task.standardError = FileHandle.nullDevice
    try task.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    guard task.terminationStatus == 0 else { throw UpdateError.message("安装包验证或准备失败，请重新下载。") }
    return data
}

private func signer(_ url: URL) throws -> Data {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate), nil) == errSecSuccess else {
        throw UpdateError.message("应用代码签名无效，更新已取消。")
    }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let values = info as? [String: Any],
          let certificates = values[kSecCodeInfoCertificates as String] as? [SecCertificate],
          let certificate = certificates.first else { throw UpdateError.message("安装包缺少可信签名。") }
    return SecCertificateCopyData(certificate) as Data
}

private func prepareArchive(_ archive: URL, checksum: Data, update: Update, work: URL, target: URL) throws -> URL {
    try ReleasePolicy.verifyChecksum(checksum, archive: archive, name: update.archive.name)
    let listing = try runTool("/usr/bin/unzip", ["-Z1", archive.path])
    guard let text = String(data: listing, encoding: .utf8) else { throw UpdateError.invalidArchive }
    try ReleasePolicy.validateArchivePaths(text)
    // Reject symlinks before extraction, including links which could redirect a later ZIP entry.
    let details = try runTool("/usr/bin/zipinfo", ["-l", archive.path])
    guard let lines = String(data: details, encoding: .utf8),
          !lines.split(separator: "\n").contains(where: { $0.hasPrefix("l") }) else { throw UpdateError.invalidArchive }
    let unpacked = work.appendingPathComponent("unpacked", isDirectory: true)
    try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    _ = try runTool("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path])
    let app = unpacked.appendingPathComponent("Lake.app", isDirectory: true)
    guard let bundle = Bundle(url: app), bundle.bundleIdentifier == "com.cleanlakes.lake.desktop",
          bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == update.version,
          try signer(app) == signer(target) else { throw UpdateError.message("安装包的版本或签名与当前客户端不匹配。") }
    _ = try runTool("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    // Execute only after authenticating the app and all nested code.
    let cliVersion = try runTool(app.appendingPathComponent("Contents/Resources/lake").path, ["--version"])
    guard String(data: cliVersion, encoding: .utf8)?.hasPrefix("Lake " + update.version + " ") == true else {
        throw UpdateError.message("安装包后端版本不匹配。")
    }
    let staged = target.deletingLastPathComponent().appendingPathComponent(".Lake-update-" + UUID().uuidString + ".app")
    do {
        _ = try runTool("/usr/bin/ditto", ["--norsrc", app.path, staged.path])
        _ = try runTool("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged.path])
        return staged
    } catch {
        try? FileManager.default.removeItem(at: staged)
        throw error
    }
}

@MainActor final class Updater {
    private(set) var state: UpdateState
    var changed: ((UpdateState) -> Void)?
    var beforeInstall: (() async throws -> InstallContext)?
    private var available: Update?
    private var busy = false
    private var downloadID: UUID?
    private var cleanupScheduled = false
    private var timer: Timer?
    private var lastCheck: Date?
    private let session: URLSession
    private let target = Bundle.main.bundleURL.resolvingSymlinksInPath()
    private let profile = DesktopProfile(bundleIdentifier: Bundle.main.bundleIdentifier)
    private let updatesDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Lake/updates", isDirectory: true)

    init() {
        state = UpdateState(currentVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0")
        if profile.isDevelopment { state.message = "本地测试版：通过本地构建更新，不接收正式版更新" }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 1800
        session = URLSession(configuration: config)
    }
    private func publish(_ status: String, _ message: String) {
        state.status = status
        state.message = message
        changed?(state)
    }
    func start() {
        guard profile.allowsReleaseUpdates else { return }
        cleanupOldPackages()
        guard timer == nil else { return }
        Task { await check() }
        let periodic = Timer(timeInterval: 300, repeats: true) { [weak self] _ in
            guard let updater = self else { return }
            Task { @MainActor in await updater.check() }
        }
        timer = periodic
        RunLoop.main.add(periodic, forMode: .common)
        if let jobs = try? FileManager.default.contentsOfDirectory(at: updatesDirectory, includingPropertiesForKeys: nil) {
            for job in jobs {
                let error = job.appendingPathComponent("error")
                if let data = try? Data(contentsOf: error), let message = String(data: data, encoding: .utf8) {
                    publish("error", message.trimmingCharacters(in: .whitespacesAndNewlines))
                    try? FileManager.default.removeItem(at: error)
                }
            }
        }
    }
    // Receipt-bearing launches may still be inside the installer rollback window.
    // Wait for its completion marker or job removal before pruning older backups.
    func cleanupOldPackages() {
        guard !cleanupScheduled, profile.allowsReleaseUpdates else { return }
        cleanupScheduled = true
        let target = target, directory = updatesDirectory, version = state.currentVersion
        let args = CommandLine.arguments
        let receiptIndex = args.firstIndex(of: "--lake-update-receipt")
        let work = receiptIndex.flatMap { index -> URL? in
            guard index + 1 < args.count else { return nil }
            let receipt = URL(fileURLWithPath: args[index + 1]).standardizedFileURL
            let job = receipt.deletingLastPathComponent()
            guard receipt.lastPathComponent == "ready", UUID(uuidString: job.lastPathComponent) != nil,
                  job.deletingLastPathComponent() == directory.standardizedFileURL else { return nil }
            return job
        }
        Task {
            defer { cleanupScheduled = false }
            await Task.detached {
                for attempt in 0..<60 {
                    if let work, FileManager.default.fileExists(atPath: work.path),
                       !FileManager.default.fileExists(atPath: work.appendingPathComponent("complete").path) {
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                        continue
                    }
                    do {
                        try UpdateCleanup.removeObsoleteBackups(target: target, currentVersion: version)
                        try UpdateCleanup.removeCompletedDownloads(directory: directory, currentVersion: version)
                        return
                    } catch {
                        if attempt < 59 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
                    }
                }
            }.value
        }
    }
    func checkIfDue() async {
        guard lastCheck.map({ Date().timeIntervalSince($0) >= 300 }) ?? true else { return }
        await check()
    }
    func check(preview: Bool = false) async {
        guard profile.allowsReleaseUpdates || preview else { return }
        cleanupOldPackages()
        guard !busy else { return }
        lastCheck = Date()
        busy = true
        defer { busy = false }
        publish("checking", "正在检测 master 的正式版本…")
        do {
            var request = URLRequest(url: URL(string: "https://api.github.com/repos/Clean-Lakes/Lake/releases?per_page=100")!)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
            request.setValue("Lake-macOS/" + state.currentVersion, forHTTPHeaderField: "User-Agent")
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 4 * 1024 * 1024 else {
                throw UpdateError.message("GitHub 更新检测失败或请求受限，请稍后重试。")
            }
            let releases = try JSONDecoder().decode([Release].self, from: data)
            #if arch(arm64)
            let architecture = "arm64"
            #else
            let architecture = "x86_64"
            #endif
            available = ReleasePolicy.latest(releases, current: state.currentVersion, architecture: architecture)
            state.updateAvailable = available != nil
            state.version = available?.version
            state.releaseNotes = available?.releaseNotes ?? releases.first(where: {
                !$0.draft && !$0.prerelease && $0.target_commitish == "master" && Version($0.tag_name) == Version(state.currentVersion)
            })?.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if let update = available {
                publish("available", profile.isDevelopment ? "正式版发布了 Lake \(update.version)，本地测试版使用本地构建更新" : "发现 Lake \(update.version)，点击下载并重启更新")
            } else {
                publish("current", "未发现可用更新（当前版本 \(state.currentVersion)）")
            }
        } catch {
            publish("error", (error as? UpdateError)?.localizedDescription ?? "无法检测更新，请检查网络后重试。")
        }
    }
    func install() async {
        guard profile.allowsReleaseUpdates else { return }
        guard !busy, let update = available else { return }
        // A separately started CLI service must be closed by its owner before replacing its executable.
        guard FileManager.default.isWritableFile(atPath: target.deletingLastPathComponent().path),
              !target.path.contains("/AppTranslocation/"), !target.path.hasPrefix("/Volumes/") else {
            publish("error", "请先将 Lake.app 安装到可写的 Applications 目录再更新。")
            return
        }
        busy = true
        defer { busy = false }
        let downloadID = UUID()
        self.downloadID = downloadID
        state.progress = 0
        publish("downloading", "正在获取安装包校验信息…")
        let work = updatesDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        var staged: URL?
        var handedOff = false
        defer {
            self.downloadID = nil
            state.progress = nil
            if !handedOff {
                if let staged { try? FileManager.default.removeItem(at: staged) }
                try? FileManager.default.removeItem(at: work)
            }
        }
        do {
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let (checksum, checksumResponse) = try await session.data(from: update.checksum.url!)
            guard (checksumResponse as? HTTPURLResponse)?.statusCode == 200,
                  checksum.count <= 4096, Int64(checksum.count) == update.checksum.size else { throw UpdateError.invalidChecksum }
            let archive = work.appendingPathComponent("update.zip")
            let response = try await ArchiveDownload.download(from: update.archive.url!, to: archive,
                                                            expectedSize: update.archive.size, configuration: session.configuration) { [weak self] percent in
                guard let updater = self else { return }
                Task { @MainActor in
                    guard updater.downloadID == downloadID, updater.state.status == "downloading",
                          percent > (updater.state.progress ?? -1) else { return }
                    updater.state.progress = percent
                    updater.publish("downloading", "正在下载安装包…")
                }
            }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw UpdateError.message("安装包下载失败，请稍后重试。")
            }
            let size = try FileManager.default.attributesOfItem(atPath: archive.path)[.size] as? NSNumber
            guard size?.int64Value == update.archive.size else { throw UpdateError.invalidArchive }
            state.progress = 100
            publish("verifying", "正在校验安装包及应用签名…")
            let destination = target
            staged = try await Task.detached {
                try prepareArchive(archive, checksum: checksum, update: update, work: work, target: destination)
            }.value
            guard let staged, let source = Bundle.main.resourceURL?.appendingPathComponent("install-update.sh"),
                  let beforeInstall else { throw UpdateError.message("应用缺少更新安装器，请重新安装。") }
            let backend = try await beforeInstall()
            let helper = work.appendingPathComponent("install-update.sh")
            try FileManager.default.copyItem(at: source, to: helper)
            let backup = target.deletingLastPathComponent().appendingPathComponent("Lake.backup-" + state.currentVersion + "-" + UUID().uuidString + ".app")
            let installer = Process()
            installer.executableURL = URL(fileURLWithPath: "/bin/sh")
            installer.arguments = [helper.path, String(getpid()), String(backend.pid), staged.path, target.path, backup.path, work.path, update.version, "/usr/bin/open", "45", backend.home.path, backend.data.path]
            installer.standardInput = FileHandle.nullDevice
            installer.standardOutput = FileHandle.nullDevice
            installer.standardError = FileHandle.nullDevice
            try installer.run()
            handedOff = true
            publish("installing", "即将退出 Lake，安装更新并重新打开…")
            NSApplication.shared.terminate(nil)
        } catch {
            state.progress = nil
            publish("error", (error as? UpdateError)?.localizedDescription ?? "更新下载或安装失败，请检查网络和磁盘空间后重试。")
        }
    }
}
