import SwiftUI
import AppKit
import FigmaMCPKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = AppModel(engine: CLIEngine.bundled(),
                         opener: PluginOpener(access: SystemFigmaMenu()),
                         login: SystemLoginItem(),
                         updates: .live, launchPing: .live)
    var socket: CommandSocket?
    var window: NSWindow?

    func applicationDidFinishLaunching(_ n: Notification) {
        model.onNeedSetupWindow = { [weak self] in self?.showSetupWindow() }
        model.start()
        let m = model
        let sock = CommandSocket(path: ProcessInfo.processInfo.environment["FIGMAMCP_SOCKET"] ?? CommandSocket.defaultPath) { cmd in
            await m.handleCommand(cmd)
        }
        try? sock.start()
        socket = sock
        // Show setup on first launch, once we know whether it is needed.
        Task { @MainActor in
            await model.refresh()
            if !Flow.isSetUp(model.snapshot) { showSetupWindow() }
        }
    }

    func applicationWillTerminate(_ n: Notification) { socket?.stop() }

    func showSetupWindow() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(origin: .zero, size: FirstRunView.size),
                             styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
            w.title = "FigmaMCP"
            w.titlebarAppearsTransparent = true
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: FirstRunView(model: model))
            w.center()
            w.delegate = self
            window = w
        }
        // Menu-bar apps are hidden from Command-Tab; show in it while the window is open.
        NSApp.setActivationPolicy(AppPresence.policy(setupWindowOpen: true))
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ n: Notification) {
        NSApp.setActivationPolicy(AppPresence.policy(setupWindowOpen: false))
    }

    // Clicking the Dock icon brings the setup window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if window?.isVisible == true { window?.makeKeyAndOrderFront(nil) }
        return true
    }
}

struct FigmaMCPApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        MenuBarExtra {
            PopoverView(model: delegate.model)
        } label: {
            MenuBarLabel(model: delegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}

struct MenuBarLabel: View {
    @ObservedObject var model: AppModel
    var body: some View { Image(systemName: model.status.barSymbol) }
}

FigmaMCPApp.main()
