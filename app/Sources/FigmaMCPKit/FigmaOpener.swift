import Foundation
import AppKit
import ApplicationServices

public enum OpenOutcome: String, Sendable, Equatable {
    case opened
    case figmaNotInstalled = "figma-not-installed"
    case noFileOpen = "no-file-open"
    case accessDenied = "access-denied"
    case menuItemMissing = "menu-item-missing"

    /// Shown in the app, in the user's language.
    public var message: String {
        switch self {
        case .opened: return L10n.t(english, "FigmaMCP 已在 Figma 中打开。")
        case .figmaNotInstalled: return L10n.t(english, "这台 Mac 上没有安装 Figma。")
        case .noFileOpen: return L10n.t(english, "请先打开一个 Figma 文件，然后再试一次。")
        case .accessDenied: return L10n.t(english, "FigmaMCP 还没有被允许在 Figma 中打开内容。")
        case .menuItemMissing: return L10n.t(english, "Figma 的菜单中还没有 FigmaMCP。请点击“重新设置”。")
        }
    }

    /// Sent to the AI, always English.
    public var english: String {
        switch self {
        case .opened: return "FigmaMCP is open in Figma."
        case .figmaNotInstalled: return "Figma is not installed on this Mac."
        case .noFileOpen: return "Open a Figma file first, then try again."
        case .accessDenied: return "FigmaMCP is not allowed to open things in Figma yet."
        case .menuItemMissing: return "FigmaMCP is not in Figma's menu yet. Run Set up again."
        }
    }

    public var json: [String: Any] {
        ["ok": self == .opened, "outcome": rawValue, "message": english]
    }
}

/// The few things the opener needs from the machine. Faked in tests.
public protocol FigmaMenuAccess: AnyObject {
    var isTrusted: Bool { get }
    var figmaInstalled: Bool { get }
    /// Launches or activates Figma and brings it to the front.
    func activateFigma()
    /// True while Figma's menu bar has an item with this title.
    func hasMenuBarItem(_ title: String) -> Bool
    /// Presses menu bar item then nested items by title, in order. Returns false if any step is missing.
    func press(path: [String]) -> Bool
}

public struct PluginOpener {
    public var access: FigmaMenuAccess
    public var waitForMenu: TimeInterval
    public var pollInterval: TimeInterval
    public var itemNames: [String]

    public init(access: FigmaMenuAccess, waitForMenu: TimeInterval = 12, pollInterval: TimeInterval = 0.25,
                itemNames: [String] = ["FigmaMCP"]) {
        self.access = access; self.waitForMenu = waitForMenu; self.pollInterval = pollInterval; self.itemNames = itemNames
    }

    public func open() async -> OpenOutcome {
        guard access.figmaInstalled else { return .figmaNotInstalled }
        guard access.isTrusted else { return .accessDenied }
        // The Plugins menu only exists while Figma is in front with a file open.
        await MainActor.run { access.activateFigma() }
        let deadline = Date().addingTimeInterval(waitForMenu)
        var found = false
        while Date() < deadline {
            if access.hasMenuBarItem("Plugins") { found = true; break }
            try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
        }
        guard found else { return .noFileOpen }
        for name in itemNames where access.press(path: ["Plugins", "Development", name]) { return .opened }
        return .menuItemMissing
    }
}

// MARK: real implementation

public final class SystemFigmaMenu: FigmaMenuAccess {
    public static let bundleID = "com.figma.Desktop"
    public init() {}

    public var isTrusted: Bool { AXIsProcessTrusted() }

    public var figmaInstalled: Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleID) != nil
    }

    var runningApp: NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID).first
    }

    public func activateFigma() {
        if let app = runningApp {
            app.activate(options: [.activateAllWindows])
        } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleID) {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    private func menuBar() -> AXUIElement? {
        guard let app = runningApp else { return nil }
        let el = AXUIElementCreateApplication(app.processIdentifier)
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXMenuBarAttribute as CFString, &v) == .success else { return nil }
        return (v as! AXUIElement)
    }

    private func children(_ e: AXUIElement) -> [AXUIElement] {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &v) == .success else { return [] }
        return (v as? [AXUIElement]) ?? []
    }

    private func title(_ e: AXUIElement) -> String {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXTitleAttribute as CFString, &v) == .success else { return "" }
        return (v as? String) ?? ""
    }

    public func hasMenuBarItem(_ name: String) -> Bool {
        guard let bar = menuBar() else { return false }
        return children(bar).contains { title($0) == name }
    }

    /// Item with this title directly under `container`, or inside the AXMenu that `container` holds.
    private func find(_ name: String, in container: AXUIElement) -> AXUIElement? {
        for c in children(container) {
            if title(c) == name { return c }
            for inner in children(c) where title(inner) == name { return inner }
        }
        return nil
    }

    public func press(path: [String]) -> Bool {
        guard var container = menuBar() else { return false }
        for name in path {
            // Submenus take a moment to build after the parent is pressed.
            var match: AXUIElement?
            for _ in 0..<15 {
                match = find(name, in: container)
                if match != nil { break }
                Thread.sleep(forTimeInterval: 0.1)
            }
            guard let item = match, AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { return false }
            container = item
        }
        return true
    }
}

public enum AccessibilityGate {
    public static var granted: Bool { AXIsProcessTrusted() }

    /// Asks macOS to list this app in the Accessibility pane, then opens exactly that pane.
    public static func requestAndOpenSettings() {
        let opts = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
}
