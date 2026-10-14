import Foundation

/// Each distribution owns its application identity, preferences and backend directory.
public struct DesktopProfile {
    public let isDevelopment: Bool
    public var name: String { isDevelopment ? "Lake Dev" : "Lake" }
    public var homeDirectoryName: String { isDevelopment ? ".lake-dev" : ".lake" }
    public var homeEnvironmentKey: String { isDevelopment ? "LAKE_DEV_HOME" : "LAKE_HOME" }
    public var dataEnvironmentKey: String { isDevelopment ? "LAKE_DEV_WEB_DATA_DIR" : "LAKE_WEB_DATA_DIR" }
    public var allowsReleaseUpdates: Bool { !isDevelopment }

    public init(bundleIdentifier: String?) {
        isDevelopment = bundleIdentifier == "com.cleanlakes.lake.desktop.dev"
    }

    public func directories(userHome: String, environment: [String: String], arguments: [String]) -> (home: URL, data: URL) {
        func argument(_ name: String) -> String? {
            guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        let home = URL(fileURLWithPath: argument("--lake-home") ?? environment[homeEnvironmentKey]
                       ?? userHome + "/" + homeDirectoryName, isDirectory: true)
        let data = (argument("--lake-data") ?? environment[dataEnvironmentKey])
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? home.appendingPathComponent("web-agent", isDirectory: true)
        return (home, data)
    }
}
