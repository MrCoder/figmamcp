import AppKit

/// Whether the app shows in the Dock and the Command-Tab switcher.
/// The app is menu-bar only (`LSUIElement`), which hides every window it opens from
/// Command-Tab: once the setup window loses focus, the user cannot find it again.
public enum AppPresence {
    public static func policy(setupWindowOpen: Bool) -> NSApplication.ActivationPolicy {
        setupWindowOpen ? .regular : .accessory
    }
}
