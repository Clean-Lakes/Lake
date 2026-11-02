import Foundation

// The UI can detach from an independently owned kernel. Stopping/updating is
// explicit and uses the private authenticated loopback channel, even when this
// UI did not spawn the process. Never signal a PID read from an unverified file.
enum SuperagentConnection {
    static func matches(_ info: RuntimeInfo, home: URL, data: URL) async -> Bool {
        guard let origin = info.url else { return false }
        var request = URLRequest(url: origin.appendingPathComponent("api/superagent/lifecycle"))
        request.timeoutInterval = 2
        request.setValue("Bearer " + info.token, forHTTPHeaderField: "Authorization")
        guard let (body, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let value = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              value["pid"] as? Int32 == info.pid,
              value["backendRuntime"] as? String == "go",
              value["draining"] as? Bool == false,
              let actualHome = value["home"] as? String,
              let actualData = value["dataDirectory"] as? String else { return false }
        return normalized(URL(fileURLWithPath: actualHome)) == normalized(home)
            && normalized(URL(fileURLWithPath: actualData)) == normalized(data)
    }

    static func drain(_ info: RuntimeInfo, home: URL, data: URL) async -> Bool {
        guard await matches(info, home: home, data: data), let origin = info.url else { return false }
        var request = URLRequest(url: origin.appendingPathComponent("api/superagent/lifecycle"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("Bearer " + info.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(#"{"action":"drain"}"#.utf8)
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 202 else { return false }
        for _ in 0..<300 {
            if kill(info.pid, 0) != 0 && errno == ESRCH { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return false // No forced kill or replacement while a Home owner remains.
    }

    private static func normalized(_ url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path
    }
}
