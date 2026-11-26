import Foundation

/// Compares dotted release versions such as "0.1.10". Numbers compare as numbers, so 0.1.9 < 0.1.10.
public enum VersionCompare {
    /// "v0.1.12" or "0.1.12" becomes [0, 1, 12]. Anything that is not dotted numbers (for example "0.1.12-beta") is nil.
    public static func parse(_ text: String) -> [Int]? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else { return nil }
        var numbers: [Int] = []
        for p in parts {
            guard !p.isEmpty, p.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(p) else { return nil }
            numbers.append(n)
        }
        while numbers.count < 3 { numbers.append(0) }
        return numbers
    }

    /// True only when both versions parse and `latest` is strictly newer.
    public static func isNewer(_ latest: String, than current: String) -> Bool {
        guard let a = parse(latest), let b = parse(current) else { return false }
        return a.lexicographicallyPrecedes(b) ? false : (a != b)
    }
}

/// Looks for a newer release on GitHub. It never installs anything and never reports a failure.
public struct UpdateChecker: Sendable {
    public static let latestReleaseURL = URL(string: "https://api.github.com/repos/MrCoder/figmamcp-releases/releases/latest")!
    public static let downloadPage = URL(string: "https://figmamcp.dev/download")!

    let fetch: @Sendable (URL) async throws -> Data
    public init(fetch: @escaping @Sendable (URL) async throws -> Data) { self.fetch = fetch }

    public static let live = UpdateChecker { url in
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }

    /// The newer version without a leading "v" (for example "0.1.12"), or nil when up to date or when anything fails.
    public func newerVersion(than current: String) async -> String? {
        guard let data = try? await fetch(Self.latestReleaseURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = object["tag_name"] as? String,
              VersionCompare.isNewer(tag, than: current) else { return nil }
        return tag.hasPrefix("v") || tag.hasPrefix("V") ? String(tag.dropFirst()) : tag
    }
}
