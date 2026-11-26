import Foundation

/// The text behind "Copy diagnostics": doctor's own report with personal details taken out.
public enum Diagnostics {
    /// Replaces the home folder, user name, host name and Figma file names (user content) in `raw`.
    public static func redact(_ raw: String, home: String, user: String, host: String, fileNames: [String]) -> String {
        var out = raw
        if !home.isEmpty { out = out.replacingOccurrences(of: home, with: "~") }
        // File names only where they are quoted, so a file called "A" or "UI" cannot mangle other text.
        for (i, name) in fileNames.filter({ !$0.isEmpty }).sorted(by: { $0.count > $1.count }).enumerated() {
            for (l, r) in [("\"", "\""), ("\u{201C}", "\u{201D}")] {
                out = out.replacingOccurrences(of: l + name + r, with: "\"file \(i + 1)\"")
            }
        }
        let shortHost = host.split(separator: ".").first.map(String.init) ?? host
        for (word, label) in [(host, "<host>"), (shortHost, "<host>"), (user, "<user>")] where word.count >= 3 {
            let pattern = "\\b" + NSRegularExpression.escapedPattern(for: word) + "\\b"
            out = out.replacingOccurrences(of: pattern, with: label, options: [.regularExpression, .caseInsensitive])
        }
        return out
    }

    public static func header(appVersion: String) -> String {
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        return """
        FigmaMCP app \(appVersion)
        macOS \(os)
        Language \(Locale.preferredLanguages.first ?? "?")

        """
    }

    public static func build(doctorText: String, report: EngineReport?, appVersion: String) -> String {
        let names = report?.openFiles.compactMap(\.name) ?? []
        let steps = (report?.steps ?? []).map { "  \($0.id): \($0.rawState.isEmpty ? $0.state.rawValue : $0.rawState)" }.joined(separator: "\n")
        let text = header(appVersion: appVersion) + doctorText + "\n\nSteps as the app read them:\n" + steps + "\n"
        return redact(text, home: NSHomeDirectory(), user: NSUserName(), host: ProcessInfo.processInfo.hostName, fileNames: names)
    }
}
