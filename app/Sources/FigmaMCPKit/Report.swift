import Foundation

/// One line of the engine's answer. The engine is another program, so parsing is tolerant:
/// unknown states become `.todo`, never `.ok`, so we never show a false tick.
public enum StepState: String, Sendable, Equatable {
    case ok, todo, fail, skip, warn

    public init(raw: String?) {
        switch (raw ?? "").lowercased() {
        case "ok", "done", "pass", "passed", "ready", "success", "good", "installed", "connected": self = .ok
        case "fail", "failed", "error", "broken", "blocked": self = .fail
        case "skip", "skipped", "none", "n/a", "absent", "notfound", "not-found": self = .skip
        case "warn", "warning": self = .warn
        default: self = .todo
        }
    }
}

public struct EngineStep: Equatable, Sendable {
    public var id: String
    public var state: StepState
    public var message: String
    public var fix: String?
    /// The engine's own state word, lowercased (e.g. "needs-figma-launch"), kept for states `StepState` folds into `.todo`.
    public var rawState: String
    public init(id: String, state: StepState, message: String = "", fix: String? = nil, rawState: String = "") {
        self.id = id; self.state = state; self.message = message; self.fix = fix; self.rawState = rawState
    }
}

public struct OpenFile: Equatable, Sendable {
    public var name: String?
    public var aiSessions: Int
    /// The FigmaMCP panel in this file is from another version; AI calls to it are refused until it is reopened.
    public var outdated: Bool
    /// AI requests this file answered without an error since the helper started; nil from an older engine.
    public var completedCalls: Int?
    public init(name: String?, aiSessions: Int, outdated: Bool = false, completedCalls: Int? = nil) {
        self.name = name; self.aiSessions = aiSessions; self.outdated = outdated; self.completedCalls = completedCalls
    }
}

public struct EngineReport: Equatable, Sendable {
    public var steps: [EngineStep]
    public var currentFile: String?
    public var figmaRunning: Bool?
    /// Files where FigmaMCP is open now, from the relay.
    public var openFiles: [OpenFile]
    /// Running FigmaMCP sessions per AI step id ("agent-claude"). Missing key = the engine could not say.
    public var loaded: [String: Int]
    public init(steps: [EngineStep], currentFile: String? = nil, figmaRunning: Bool? = nil, openFiles: [OpenFile] = [], loaded: [String: Int] = [:]) {
        self.steps = steps; self.currentFile = currentFile; self.figmaRunning = figmaRunning; self.openFiles = openFiles; self.loaded = loaded
    }
    public func step(_ id: String) -> EngineStep? { steps.first { $0.id == id } }
    public func steps(prefix: String) -> [EngineStep] { steps.filter { $0.id.hasPrefix(prefix) } }
}

public enum ReportParser {
    /// Returns nil when no JSON can be found at all.
    public static func parse(_ data: Data) -> EngineReport? {
        guard let json = extractJSON(data) else { return nil }
        var rawSteps: [Any] = []
        var file: String?
        var running: Bool?
        var open: [OpenFile] = []
        var loaded: [String: Int] = [:]
        if let arr = json as? [Any] {
            rawSteps = arr
        } else if let obj = json as? [String: Any] {
            rawSteps = (obj["steps"] as? [Any]) ?? (obj["checks"] as? [Any]) ?? []
            file = (obj["currentFile"] ?? obj["file"] ?? obj["figmaFile"] ?? obj["fileName"]) as? String
            if let f = file, f.isEmpty { file = nil }
            running = (obj["figmaRunning"] ?? obj["figma_running"]) as? Bool
            open = ((obj["openFiles"] as? [Any]) ?? []).compactMap { item in
                guard let d = item as? [String: Any] else { return nil }
                let n = d["fileName"] as? String
                return OpenFile(name: (n?.isEmpty ?? true) ? nil : n, aiSessions: (d["aiSessions"] as? Int) ?? 0,
                                outdated: (d["outdated"] as? Bool) ?? false, completedCalls: d["completedCalls"] as? Int)
            }
            for (key, id) in [("claude", "agent-claude"), ("codex", "agent-codex")] {
                if let n = (obj[key] as? [String: Any])?["loaded"] as? Int { loaded[id] = n }
            }
        } else { return nil }
        let steps: [EngineStep] = rawSteps.compactMap { item in
            guard let d = item as? [String: Any] else { return nil }
            guard let id = (d["id"] ?? d["step"] ?? d["name"]) as? String else { return nil }
            let raw = (d["state"] ?? d["status"] ?? d["result"]) as? String
            let state = StepState(raw: raw)
            let message = (d["message"] ?? d["detail"] ?? d["title"]) as? String ?? ""
            var fix: String?
            if let s = d["fix"] as? String, !s.isEmpty { fix = s }
            else if let o = d["fix"] as? [String: Any] { fix = (o["label"] ?? o["message"] ?? o["command"]) as? String }
            return EngineStep(id: id, state: state, message: message, fix: fix, rawState: (raw ?? "").lowercased())
        }
        return EngineReport(steps: steps, currentFile: file, figmaRunning: running, openFiles: open, loaded: loaded)
    }

    static func extractJSON(_ data: Data) -> Any? {
        if let direct = try? JSONSerialization.jsonObject(with: data) { return direct }
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        // Tolerate log lines around the JSON.
        guard let start = text.firstIndex(where: { $0 == "{" || $0 == "[" }),
              let end = text.lastIndex(where: { $0 == "}" || $0 == "]" }), start < end else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(text[start...end].utf8))
    }
}

/// The product never shows engine jargon. Engine text is shown only if it is already plain.
public enum PlainEnglish {
    static let banned = ["port", "relay", "channel", "mcp", "manifest", "plugin", "launchctl", "pid ", "node.js", "stderr", "json"]
    public static func safe(_ text: String?) -> String? {
        // Engine text is English; in Chinese the localized generic line is shown instead.
        if L10n.lang == .zh { return nil }
        guard let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        let lower = t.lowercased().replacingOccurrences(of: "figmamcp", with: "")
        if banned.contains(where: { lower.contains($0) }) { return nil }
        return t
    }
}
