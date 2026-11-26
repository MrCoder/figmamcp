import Foundation

/// One anonymous launch count per app start: the app version and a random app ID. Nothing else is sent.
/// The address has the same shape as the plugin's load count: p.gif?v=<version>&i=<16 hex characters>.
/// Since 0.1.24 the same start is also sent as a Mixpanel `app_launched` event through figmamcp.dev/mp/track
/// (app version, macOS major version, the same app ID), unless telemetry is turned off.
public struct LaunchPing: Sendable {
    static let defaultsKey = "launchPingID"
    public static let trackURL = URL(string: "https://figmamcp.dev/mp/track")!

    let send: @Sendable (URL) async -> Void
    let track: (@Sendable (URLRequest) async -> Void)?
    let telemetryOn: @Sendable () -> Bool
    public init(send: @escaping @Sendable (URL) async -> Void,
                track: (@Sendable (URLRequest) async -> Void)? = nil,
                telemetryOn: @escaping @Sendable () -> Bool = { LaunchPing.telemetryEnabled() }) {
        self.send = send; self.track = track; self.telemetryOn = telemetryOn
    }

    /// Best effort: a failed request is ignored.
    public static let live = LaunchPing(send: { url in
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        _ = try? await URLSession.shared.data(for: request)
    }, track: { request in
        _ = try? await URLSession.shared.data(for: request)
    })

    /// A random 16-character hex ID, made once and kept in UserDefaults. A stored value that does not match is replaced.
    public static func appID(defaults: UserDefaults) -> String {
        if let stored = defaults.string(forKey: defaultsKey), isValid(stored) { return stored }
        let id = (0..<16).map { _ in String(Int.random(in: 0..<16), radix: 16) }.joined()
        defaults.set(id, forKey: defaultsKey)
        return id
    }

    static func isValid(_ id: String) -> Bool {
        id.count == 16 && id.allSatisfy { $0.isASCII && ($0.isNumber || ("a"..."f").contains($0)) }
    }

    public static func url(version: String, id: String) -> URL {
        var c = URLComponents(string: "https://figmamcp.dev/p.gif")!
        c.queryItems = [URLQueryItem(name: "v", value: "app-\(version)"), URLQueryItem(name: "i", value: id)]
        return c.url!
    }

    /// FIGMAMCP_TELEMETRY=0 in the environment, or "telemetry": false in ~/.figmamcp/config.json, turns events off.
    public static func telemetryEnabled(environment: [String: String] = ProcessInfo.processInfo.environment,
                                        home: String = NSHomeDirectory()) -> Bool {
        if let flag = environment["FIGMAMCP_TELEMETRY"]?.trimmingCharacters(in: .whitespaces).lowercased(),
           ["0", "false", "off", "no"].contains(flag) { return false }
        let path = (home as NSString).appendingPathComponent(".figmamcp/config.json")
        if let data = FileManager.default.contents(atPath: path),
           let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let on = config["telemetry"] as? Bool, on == false { return false }
        return true
    }

    /// The app_launched event. Fixed fields only: no user, file or machine name.
    public static func trackRequest(version: String, id: String, now: Date = Date(),
                                    osMajor: Int = ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
                                    insertID: String = UUID().uuidString.lowercased()) -> URLRequest {
        var properties: [String: Any] = [
            "distinct_id": id,
            "time": Int(now.timeIntervalSince1970 * 1000),
            "$insert_id": insertID,
            "product": "figmamcp",
            "os": "macOS \(osMajor)",
        ]
        if version.range(of: "^\\d+\\.\\d+\\.\\d+$", options: .regularExpression) != nil { properties["app_version"] = version }
        var request = URLRequest(url: trackURL, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [["event": "app_launched", "properties": properties]])
        return request
    }

    public func ping(version: String, defaults: UserDefaults) async {
        let id = Self.appID(defaults: defaults)
        await send(Self.url(version: version, id: id))
        if let track, telemetryOn() { await track(Self.trackRequest(version: version, id: id)) }
    }
}
