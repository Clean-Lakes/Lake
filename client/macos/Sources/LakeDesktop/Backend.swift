import Foundation
import LakeUpdateCore

struct RuntimeInfo: Decodable {
    let origin: String
    let token: String
    let pid: Int32
    var url: URL? {
        guard let u = URL(string: origin), u.scheme == "http", u.host == "localhost",
              let port = u.port, port > 0, u.user == nil, u.password == nil,
              u.path.isEmpty, u.query == nil, u.fragment == nil, !token.isEmpty, pid > 0 else { return nil }
        return u
    }
}

@MainActor final class Backend {
    private(set) var process: Process?
    private(set) var runtime: RuntimeInfo?
    let home: URL
    let dataDirectory: URL
    let backendRuntime: String
    init() {
        let profile = DesktopProfile(bundleIdentifier: Bundle.main.bundleIdentifier)
        backendRuntime = profile.backendRuntime(requested: Bundle.main.object(forInfoDictionaryKey: "LakeBackendRuntime") as? String)
        let directories = profile.directories(userHome: NSHomeDirectory(),
            environment: ProcessInfo.processInfo.environment, arguments: CommandLine.arguments)
        home = directories.home
        dataDirectory = directories.data
    }
    private func readRuntime() -> RuntimeInfo? {
        let file = dataDirectory.appendingPathComponent("runtime.json")
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
              let permissions = attrs[.posixPermissions] as? NSNumber, permissions.intValue & 0o077 == 0,
              let owner = attrs[.ownerAccountID] as? NSNumber, owner.uint32Value == getuid(),
              let data = try? Data(contentsOf: file),
              let info = try? JSONDecoder().decode(RuntimeInfo.self, from: data), info.url != nil else { return nil }
        return info
    }
    private func healthy(_ info: RuntimeInfo) async -> Bool {
        guard let origin = info.url else { return false }
        var request = URLRequest(url: origin.appendingPathComponent("api/bootstrap"))
        request.timeoutInterval = 2
        request.setValue("Bearer " + info.token, forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["backendRuntime"] as? String == backendRuntime else { return false }
        return await SuperagentConnection.matches(info, home: home, data: dataDirectory, backendRuntime: backendRuntime)
    }
    func start() async throws -> URL {
        if let existing = readRuntime(), await healthy(existing) {
            runtime = existing
        } else {
            guard let cli = Bundle.main.resourceURL?.appendingPathComponent("lake"),
                  FileManager.default.isExecutableFile(atPath: cli.path) else {
                throw UpdateError.message("应用缺少 Lake 后端，请重新安装。")
            }
            let child = Process()
            child.executableURL = cli
            // Port 0 binds a free loopback port atomically.
            child.arguments = ["web", "--port", "0"]
            if backendRuntime == "typescript" {
                child.arguments = ["web", "--port", "0", "--home", home.path, "--data", dataDirectory.path, "--dev", "--migrate-legacy"]
            }
            var environment = ProcessInfo.processInfo.environment
            environment["LAKE_HOME"] = home.path
            environment["LAKE_WEB_DATA_DIR"] = dataDirectory.path
            environment.removeValue(forKey: "LAKE_WEB_START_OPEN")
            environment.removeValue(forKey: "LAKE_WEB_DEV_ORIGIN")
            environment.removeValue(forKey: "LAKE_TS_IMPORT_ONLY")
            if DesktopProfile(bundleIdentifier: Bundle.main.bundleIdentifier).isDevelopment {
                environment.removeValue(forKey: "LAKE_WEB_TOKEN")
            }
            child.environment = environment
            child.standardOutput = FileHandle.nullDevice
            child.standardError = FileHandle.nullDevice
            try child.run()
            process = child
            for _ in 0..<100 {
                guard child.isRunning else { throw UpdateError.message("Lake 后端无法启动。数据目录可能已有服务，请先关闭旧服务。") }
                if let info = readRuntime(), info.pid == child.processIdentifier, await healthy(info) {
                    runtime = info
                    break
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        guard let info = runtime, let origin = info.url,
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            throw UpdateError.message("Lake 后端启动超时，请重新打开应用。")
        }
        components.path = "/"
        components.fragment = "token=" + info.token
        return components.url!
    }
    func detach() {
        // Process deallocation does not terminate the service. Keep its
        // private runtime record for the next UI's authenticated reconnect.
        process = nil
        runtime = nil
    }
    func stop() async -> Bool {
        guard let info = runtime ?? readRuntime() else { return process?.isRunning != true }
        if kill(info.pid, 0) != 0 && errno == ESRCH { detach(); return true }
        let stopped = await SuperagentConnection.drain(info, home: home, data: dataDirectory, backendRuntime: backendRuntime)
        if stopped { detach() }
        return stopped
    }
}
