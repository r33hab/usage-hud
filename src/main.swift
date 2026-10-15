// usage-hud - a floating always-on-top panel showing Claude Code and Codex usage.
// The panel is a borderless NSPanel with an NSVisualEffectView for real macOS
// vibrancy and a transparent WKWebView on top rendering ui/hud.html. Data comes
// from collect.mjs, run on a timer.

import AppKit
import Carbon.HIToolbox
import WebKit

// MARK: - Constants

private let panelWidth: CGFloat = 380
private let defaultHeight: CGFloat = 320
private let cornerRadius: CGFloat = 14
private let frameKey = "panelOrigin"
private let configPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".config/usage-hud/config.json")
private let historyDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".config/usage-hud/history")
private let historyKeep = 20
private let savedDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".config/usage-hud/saved")
private let launchAgentLabel = "com.r33hab.usage-hud"
private let launchAgentPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel).plist")
private let ghostKey = "ghostMode"
private let hiddenKey = "startHidden"
private let menuBarIconKey = "menuBarIcon"

// MARK: - Node discovery
// A bundled .app launches with a minimal PATH, so nvm's node is invisible to it.
// Every candidate has to be an absolute path.

private func findNode() -> String? {
    let fm = FileManager.default
    var candidates: [String] = []

    if let env = ProcessInfo.processInfo.environment["USAGE_HUD_NODE"] { candidates.append(env) }
    if let url = Bundle.main.url(forResource: "node-path", withExtension: "txt"),
       let recorded = try? String(contentsOf: url, encoding: .utf8) {
        candidates.append(recorded.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]

    // nvm installs: pick the highest version present.
    let nvm = fm.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
    if let versions = try? fm.contentsOfDirectory(atPath: nvm.path) {
        for v in versions.sorted(by: versionGreater) {
            candidates.append(nvm.appendingPathComponent("\(v)/bin/node").path)
        }
    }

    return candidates.first { !$0.isEmpty && fm.isExecutableFile(atPath: $0) }
}

private func versionGreater(_ a: String, _ b: String) -> Bool {
    let pa = a.dropFirst(a.hasPrefix("v") ? 1 : 0).split(separator: ".").compactMap { Int($0) }
    let pb = b.dropFirst(b.hasPrefix("v") ? 1 : 0).split(separator: ".").compactMap { Int($0) }
    for i in 0..<max(pa.count, pb.count) {
        let x = i < pa.count ? pa[i] : 0
        let y = i < pb.count ? pb[i] : 0
        if x != y { return x > y }
    }
    return false
}

// MARK: - Panel

final class HudPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSWindowDelegate {

    private var panel: HudPanel!
    private var effect: NSVisualEffectView!
    private var webView: WKWebView!
    /// Off by default. The panel's right-click menu and the hotkeys cover everything it offered.
    private var statusItem: NSStatusItem?
    private var appMenu = NSMenu()
    private var timer: Timer?
    private var lastMouseDown: NSEvent?
    private var refreshInterval: TimeInterval = 60
    private var running = false
    private var nodePath: String?
    private var collectorPath: String?
    private var editing = false
    private var preferredWidth = panelWidth
    private var lastConfig: [String: Any]?
    private var hotKeyRefs: [EventHotKeyRef?] = []
    private var hotKeyHandler: EventHandlerRef?
    fileprivate var hotKeyActions: [UInt32: () -> Void] = [:]
    private var installedHotkeys: [String: String] = [:]
    private var hotkeyLabels: [String: String] = [:]
    private var configStamp: Date?
    private var configTimer: Timer?
    private var savedNames: [String] = []

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        // Two panels stacked on top of each other look like a rendering bug and
        // double the collector's work. A launch-at-login start racing a manual
        // `open` is the usual way that happens.
        let mine = Bundle.main.bundleIdentifier ?? launchAgentLabel
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: mine)
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty {
            NSLog("usage-hud: another instance is already running; exiting")
            NSApp.terminate(nil)
            return
        }

        nodePath = findNode()
        collectorPath = Bundle.main.url(forResource: "collect", withExtension: "mjs")?.path

        buildPanel()
        setMenuBarIcon(UserDefaults.standard.bool(forKey: menuBarIconKey))
        rebuildMenu()

        // Keep the most recent left mouse-down around: the web view consumes the
        // event, so performDrag(with:) needs the copy this monitor captured.
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            self?.lastMouseDown = event
            return event
        }

        // Right-click on the panel opens the app menu, so nothing depends on the
        // menu bar icon. While editing, text fields keep their own context menu.
        NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] event in
            guard let self, event.window === self.panel, !self.editing else { return event }
            NSMenu.popUpContextMenu(self.appMenu, with: event, for: self.webView)
            return nil
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(wokeUp),
            name: NSWorkspace.didWakeNotification, object: nil)

        if !UserDefaults.standard.bool(forKey: hiddenKey) {
            panel.orderFrontRegardless()
        }
        schedule()
        watchConfig()
    }

    @objc private func wokeUp() { refresh() }

    /// Opening the app again while it runs is the way back from a hidden,
    /// click-through panel when there is no menu bar icon to click.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if panel.ignoresMouseEvents { toggleGhost() }
        if !panel.isVisible { togglePanel() }
        return false
    }

    // MARK: Panel construction

    private func buildPanel() {
        let size = CGSize(width: panelWidth, height: defaultHeight)
        let saved = UserDefaults.standard.string(forKey: frameKey)
        let origin: NSPoint = {
            if let saved, let p = pointFrom(saved), isUsable(NSRect(origin: p, size: size)) { return p }
            return defaultOrigin(for: size)
        }()

        panel = HudPanel(
            contentRect: NSRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.delegate = self
        panel.ignoresMouseEvents = UserDefaults.standard.bool(forKey: ghostKey)

        // Vibrancy layer: this is what makes the panel read as a native HUD
        // rather than a flat translucent rectangle.
        let effect = NSVisualEffectView(frame: panel.contentView!.bounds)
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.autoresizingMask = [.width, .height]
        self.effect = effect
        effect.wantsLayer = true
        effect.layer?.cornerRadius = cornerRadius
        effect.layer?.masksToBounds = true
        if #available(macOS 10.15, *) { effect.layer?.cornerCurve = .continuous }
        panel.contentView = effect

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "hud")
        webView = WKWebView(frame: effect.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) { webView.underPageBackgroundColor = .clear }
        webView.allowsMagnification = false
        effect.addSubview(webView)

        if let html = Bundle.main.url(forResource: "hud", withExtension: "html") {
            webView.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
        }
    }

    private func setMenuBarIcon(_ visible: Bool) {
        if !visible {
            if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
            statusItem = nil
            return
        }
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "gauge.with.needle", accessibilityDescription: "usage")
                ?? NSImage(systemSymbolName: "speedometer", accessibilityDescription: "usage")
            button.imagePosition = .imageLeading
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        }
        item.menu = appMenu
        statusItem = item
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        let hint = hotkeyLabels["toggle"].map { "  (\($0))" } ?? ""
        let toggle = NSMenuItem(title: (panel.isVisible ? "Hide Panel" : "Show Panel") + hint,
                                action: #selector(togglePanel), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)

        let now = NSMenuItem(title: "Refresh Now", action: #selector(refreshFromMenu), keyEquivalent: "r")
        now.target = self
        menu.addItem(now)

        menu.addItem(.separator())

        let usage = NSMenuItem(title: "Usage History…", action: #selector(openUsageHistory), keyEquivalent: "")
        usage.target = self
        menu.addItem(usage)

        let edit = NSMenuItem(title: editing ? "Stop Editing Layout" : "Edit Layout…",
                              action: #selector(toggleEditing), keyEquivalent: "e")
        edit.target = self
        edit.state = editing ? .on : .off
        menu.addItem(edit)

        let appearance = NSMenuItem(title: "Appearance…", action: #selector(openAppearance), keyEquivalent: "")
        appearance.target = self
        menu.addItem(appearance)

        let saved = NSMenu()
        if savedNames.isEmpty {
            saved.addItem(NSMenuItem(title: "No Saved Configs", action: nil, keyEquivalent: ""))
        }
        for name in savedNames {
            let item = NSMenuItem(title: name, action: #selector(loadSavedFromMenu(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = name
            saved.addItem(item)
        }
        saved.addItem(.separator())
        let manage = NSMenuItem(title: "Save or Manage…", action: #selector(manageSaved), keyEquivalent: "")
        manage.target = self
        saved.addItem(manage)
        let savedItem = NSMenuItem(title: "Saved Configs", action: nil, keyEquivalent: "")
        savedItem.submenu = saved
        menu.addItem(savedItem)

        let openCfg = NSMenuItem(title: "Open Config File", action: #selector(openConfigFile), keyEquivalent: "")
        openCfg.target = self
        menu.addItem(openCfg)

        let undo = NSMenuItem(title: "Undo Config Change", action: #selector(undoConfigChange), keyEquivalent: "z")
        undo.target = self
        menu.addItem(undo)

        let hist = NSMenuItem(title: "Show Config History", action: #selector(revealHistory), keyEquivalent: "")
        hist.target = self
        menu.addItem(hist)

        menu.addItem(.separator())

        let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        login.target = self
        login.state = launchesAtLogin ? .on : .off
        menu.addItem(login)

        menu.addItem(.separator())

        let ghostHint = hotkeyLabels["ghost"].map { "  (\($0))" } ?? ""
        let ghost = NSMenuItem(title: "Ghost Mode (click-through)" + ghostHint, action: #selector(toggleGhost), keyEquivalent: "")
        ghost.target = self
        ghost.state = panel.ignoresMouseEvents ? .on : .off
        menu.addItem(ghost)

        let top = NSMenuItem(title: "Float Above Full Screen", action: #selector(toggleLevel), keyEquivalent: "")
        top.target = self
        top.state = panel.level == .screenSaver ? .on : .off
        menu.addItem(top)

        let reset = NSMenuItem(title: "Reset Position", action: #selector(resetPosition), keyEquivalent: "")
        reset.target = self
        menu.addItem(reset)

        let icon = NSMenuItem(title: "Show Menu Bar Icon", action: #selector(toggleMenuBarIcon), keyEquivalent: "")
        icon.target = self
        icon.state = statusItem != nil ? .on : .off
        menu.addItem(icon)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit usage-hud", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)

        appMenu = menu
        statusItem?.menu = menu
    }

    // MARK: Menu actions

    @objc private func togglePanel() {
        if panel.isVisible {
            panel.orderOut(nil)
            UserDefaults.standard.set(true, forKey: hiddenKey)
        } else {
            panel.orderFrontRegardless()
            UserDefaults.standard.set(false, forKey: hiddenKey)
            refresh()
        }
        rebuildMenu()
    }

    @objc private func refreshFromMenu() { refresh() }

    @objc private func toggleEditing() {
        let opening = !editing
        panel.orderFrontRegardless()
        if opening {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
        webView.evaluateJavaScript("window.hudSetEditing && window.hudSetEditing(\(opening))")
        rebuildMenu()
    }

    /// Week by week and month by month, in the panel itself.
    @objc private func openUsageHistory() {
        if !panel.isVisible { togglePanel() }
        webView.evaluateJavaScript("window.hudOpenHistory && window.hudOpenHistory()")
    }

    @objc private func openAppearance() {
        panel.orderFrontRegardless()
        webView.evaluateJavaScript("window.hudOpenDrawer && window.hudOpenDrawer()")
    }

    /// Walks back through the archive one version per invocation. The current
    /// config is archived on the way out, so undo is itself undoable.
    @objc private func undoConfigChange() {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: historyDir, includingPropertiesForKeys: [.contentModificationDateKey]),
              let newest = files.filter({ $0.pathExtension == "json" }).max(by: { a, b in
                  let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                  let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                  return da < db
              }),
              let data = try? Data(contentsOf: newest),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            NSSound.beep()
            return
        }
        writeConfig(object)              // archives the current one first
        try? fm.removeItem(at: newest)   // consumed, so a second undo goes further back
        refresh()
    }

    /// The web view applies it, so a load from the menu is the same edit as one
    /// from the editor: saved, archived, and undoable either way.
    @objc private func loadSavedFromMenu(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        webView.evaluateJavaScript("window.hudApplySavedConfig && window.hudApplySavedConfig(\(quote(name)))")
    }

    @objc private func manageSaved() {
        panel.orderFrontRegardless()
        webView.evaluateJavaScript("window.hudOpenSaved && window.hudOpenSaved()")
    }

    @objc private func revealHistory() {
        try? FileManager.default.createDirectory(at: historyDir, withIntermediateDirectories: true)
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: historyDir.path)
    }

    @objc private func toggleLaunchAtLogin() {
        setLaunchAtLogin(!launchesAtLogin)
        rebuildMenu()
    }

    @objc private func openConfigFile() {
        if !FileManager.default.fileExists(atPath: configPath.path), let config = lastConfig {
            writeConfig(config)
        }
        NSWorkspace.shared.open(configPath)
    }

    @objc private func toggleGhost() {
        let on = !panel.ignoresMouseEvents
        panel.ignoresMouseEvents = on
        UserDefaults.standard.set(on, forKey: ghostKey)
        rebuildMenu()
    }

    @objc private func toggleLevel() {
        panel.level = panel.level == .floating ? .screenSaver : .floating
        rebuildMenu()
    }

    @objc private func toggleMenuBarIcon() {
        let visible = statusItem == nil
        UserDefaults.standard.set(visible, forKey: menuBarIconKey)
        setMenuBarIcon(visible)
        rebuildMenu()
        if visible { refresh() }   // fills in the gauge title
    }

    @objc private func resetPosition() {
        var f = panel.frame
        f.origin = defaultOrigin(for: f.size)
        panel.setFrame(f, display: true, animate: true)
        saveOrigin()
        panel.orderFrontRegardless()
    }

    // MARK: Appearance

    private func material(_ name: String) -> NSVisualEffectView.Material {
        switch name {
        case "sidebar": return .sidebar
        case "popover": return .popover
        case "menu": return .menu
        case "toolTip": return .toolTip
        case "underWindowBackground": return .underWindowBackground
        case "fullScreenUI": return .fullScreenUI
        case "headerView": return .headerView
        case "contentBackground": return .contentBackground
        case "windowBackground": return .windowBackground
        default: return .hudWindow
        }
    }

    /// Window-level parts of the theme. CSS handles the rest inside the page.
    private func applyTheme(_ theme: [String: Any]) {
        if let w = theme["width"] as? Double, w.isFinite, w >= 240 {
            preferredWidth = CGFloat(w)
        }
        setWidth(editing ? 820 : preferredWidth)
        // Opacity is now the panel's own dark veil, applied in CSS. Fading the
        // whole window (alphaValue) only bled the bright desktop through the
        // vibrancy and washed the panel white, so the window stays fully opaque.
        panel.alphaValue = 1.0
        if let r = theme["radius"] as? Double {
            effect.layer?.cornerRadius = editing ? 14 : CGFloat(max(0, min(30, r)))
        }
        if let v = theme["vibrancy"] as? String {
            effect.material = material(v)
        }
        if let scheme = theme["scheme"] as? String {
            switch scheme {
            case "dark": panel.appearance = NSAppearance(named: .darkAqua)
            case "light": panel.appearance = NSAppearance(named: .aqua)
            default: panel.appearance = nil
            }
        }
    }

    /// Resizes horizontally, keeping whichever edge is parked against a screen
    /// edge so a width change does not walk the panel off the display.
    private func setWidth(_ width: CGFloat) {
        let vis = (panel.screen ?? NSScreen.main)?.visibleFrame ?? panel.frame
        let width = min(width, max(1, vis.width - 40))
        guard abs(panel.frame.width - width) > 0.5 else { return }
        var f = panel.frame
        let anchoredRight = abs(vis.maxX - f.maxX) < 80
        if anchoredRight { f.origin.x = f.maxX - width }
        f.size.width = width
        panel.setFrame(clamped(f), display: true, animate: false)
        saveOrigin()
    }

    // MARK: Global hotkeys
    // Carbon's RegisterEventHotKey is the only route to a system-wide shortcut
    // that needs no Accessibility permission and actually swallows the key.
    // NSEvent global monitors require Input Monitoring and cannot consume events.

    private static let keyCodes: [String: Int] = [
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
        "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
        "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
        "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
        "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
        "z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
        "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "space": kVK_Space, "escape": kVK_Escape, "esc": kVK_Escape, "return": kVK_Return,
        "tab": kVK_Tab, "grave": kVK_ANSI_Grave, "`": kVK_ANSI_Grave,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
        "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
        "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
    ]

    /// "cmd+alt+u" -> (key code, Carbon modifier mask, "⌥⌘U")
    private func parseCombo(_ combo: String) -> (UInt32, UInt32, String)? {
        var mods: UInt32 = 0
        var key: String?
        for part in combo.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "cmd", "command", "⌘": mods |= UInt32(cmdKey)
            case "alt", "opt", "option", "⌥": mods |= UInt32(optionKey)
            case "ctrl", "control", "⌃": mods |= UInt32(controlKey)
            case "shift", "⇧": mods |= UInt32(shiftKey)
            default: key = part
            }
        }
        guard let key, let code = Self.keyCodes[key], mods != 0 else { return nil }

        var glyph = ""
        if mods & UInt32(controlKey) != 0 { glyph += "⌃" }
        if mods & UInt32(optionKey) != 0 { glyph += "⌥" }
        if mods & UInt32(shiftKey) != 0 { glyph += "⇧" }
        if mods & UInt32(cmdKey) != 0 { glyph += "⌘" }
        glyph += key.count == 1 ? key.uppercased() : key
        return (UInt32(code), mods, glyph)
    }

    private func installHotKeyHandler() {
        guard hotKeyHandler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return noErr }
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject),
                              EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &id)
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { delegate.hotKeyActions[id.id]?() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &hotKeyHandler)
    }

    /// Re-registers only when the requested combos actually changed, so a
    /// refresh every 15 seconds does not churn system hotkey registrations.
    private func applyHotkeys(_ requested: [String: String?]) {
        let wanted = requested.compactMapValues { $0 }
        guard wanted != installedHotkeys else { return }

        for ref in hotKeyRefs where ref != nil { UnregisterEventHotKey(ref) }
        hotKeyRefs.removeAll()
        hotKeyActions.removeAll()
        hotkeyLabels.removeAll()
        installHotKeyHandler()

        let actions: [String: (UInt32, () -> Void)] = [
            "toggle": (1, { [weak self] in self?.togglePanel() }),
            "ghost": (2, { [weak self] in self?.toggleGhost() }),
        ]

        for (name, combo) in wanted.sorted(by: { $0.key < $1.key }) {
            guard let (code, mods, glyph) = parseCombo(combo) else {
                NSLog("usage-hud: cannot parse hotkey \"\(combo)\" for \(name)")
                continue
            }
            guard let (id, action) = actions[name] else { continue }
            var ref: EventHotKeyRef?
            let hkID = EventHotKeyID(signature: OSType(0x55534748), id: id)   // 'USGH'
            let status = RegisterEventHotKey(code, mods, hkID, GetApplicationEventTarget(), 0, &ref)
            if status == noErr {
                hotKeyRefs.append(ref)
                hotKeyActions[id] = action
                hotkeyLabels[name] = glyph
            } else {
                // Almost always means something else already owns the combo.
                hotkeyLabels[name] = glyph + " unavailable"
                NSLog("usage-hud: hotkey \(combo) rejected (status \(status)) - already taken?")
            }
        }

        installedHotkeys = wanted
        rebuildMenu()
    }

    // MARK: Launch at login
    // A plain user LaunchAgent rather than SMAppService: this app is ad-hoc
    // signed and lives wherever the user put it, which SMAppService.mainApp
    // does not reliably accept. launchd loads ~/Library/LaunchAgents at login,
    // so writing the file is the whole job - no bootstrap needed here, and
    // bootstrapping would spawn a second copy of an app that is already up.

    private var launchesAtLogin: Bool {
        FileManager.default.fileExists(atPath: launchAgentPath.path)
    }

    private func setLaunchAtLogin(_ on: Bool) {
        let fm = FileManager.default
        do {
            if on {
                let exe = Bundle.main.bundleURL
                    .appendingPathComponent("Contents/MacOS")
                    .appendingPathComponent(Bundle.main.infoDictionary?["CFBundleExecutable"] as? String ?? "UsageHUD")
                let plist: [String: Any] = [
                    "Label": launchAgentLabel,
                    "ProgramArguments": [exe.path],
                    "RunAtLoad": true,
                    "KeepAlive": false,          // quitting should stay quit until next login
                    "ProcessType": "Interactive",
                    "LimitLoadToSessionType": "Aqua",
                ]
                let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
                try fm.createDirectory(at: launchAgentPath.deletingLastPathComponent(),
                                       withIntermediateDirectories: true)
                try data.write(to: launchAgentPath)
            } else {
                if fm.fileExists(atPath: launchAgentPath.path) {
                    try fm.removeItem(at: launchAgentPath)
                }
                // Drop it from the running session too, so it does not come back
                // if the user logs out without restarting.
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                task.arguments = ["bootout", "gui/\(getuid())/\(launchAgentLabel)"]
                try? task.run()
                task.waitUntilExit()
            }
        } catch {
            NSLog("usage-hud: launch-at-login change failed: \(error)")
        }
    }

    // MARK: Config file

    private func stamp(_ url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
    }

    /// Copies the config aside before it is replaced, keeping the newest
    /// `historyKeep` versions. Layout is hand-made work; losing it to a stray
    /// drag or a stale second instance should be undoable.
    private func archiveConfig(before newData: Data) {
        let fm = FileManager.default
        guard let current = try? Data(contentsOf: configPath), current != newData else { return }
        do {
            try fm.createDirectory(at: historyDir, withIntermediateDirectories: true)
            let stamp = ISO8601DateFormatter()
            stamp.formatOptions = [.withYear, .withMonth, .withDay, .withTime]
            let name = "config-" + stamp.string(from: Date()).replacingOccurrences(of: ":", with: "") + ".json"
            try current.write(to: historyDir.appendingPathComponent(name))

            let files = (try? fm.contentsOfDirectory(at: historyDir, includingPropertiesForKeys: [.contentModificationDateKey]))?
                .filter { $0.pathExtension == "json" }
                .sorted { a, b in
                    let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                    let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                    return da > db
                } ?? []
            for stale in files.dropFirst(historyKeep) { try? fm.removeItem(at: stale) }
        } catch {
            NSLog("usage-hud: could not archive config: \(error)")
        }
    }

    private func writeConfig(_ object: Any) {
        let fm = FileManager.default
        do {
            let data = try JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            archiveConfig(before: data)
            try fm.createDirectory(at: configPath.deletingLastPathComponent(), withIntermediateDirectories: true)
            let tmp = configPath.deletingLastPathComponent()
                .appendingPathComponent("config.json.tmp-\(UUID().uuidString)")
            try data.write(to: tmp)
            if fm.fileExists(atPath: configPath.path) {
                _ = try fm.replaceItemAt(configPath, withItemAt: tmp)
            } else {
                try fm.moveItem(at: tmp, to: configPath)
            }
            // Our own write must not look like an external edit to the watcher.
            configStamp = stamp(configPath)
        } catch {
            NSLog("usage-hud: could not write config: \(error)")
        }
    }

    // MARK: Saved configs
    // Named copies of the editor's work, one file each, kept apart from
    // config.json so undo and the history's 20-version limit never touch them.
    // The web view decides what goes into one and applies it; this side stores.

    private func savedEntries() -> [(url: URL, name: String, entry: [String: Any])] {
        let files = (try? FileManager.default.contentsOfDirectory(at: savedDir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url),
                      let entry = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let name = entry["name"] as? String, entry["config"] is [String: Any] else { return nil }
                return (url, name, entry)
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// Names match case-insensitively, as the editor does, so saving "work"
    /// replaces "Work". A new name keeps only what is safe in a file name.
    private func savedFile(for name: String) -> URL {
        if let existing = savedEntries().first(where: { $0.name.lowercased() == name.lowercased() }) {
            return existing.url
        }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: " -_()+&,'"))
        let safe = String(String.UnicodeScalarView(name.unicodeScalars.map { allowed.contains($0) ? $0 : "-" }))
        // "a/b" and "a-b" share a file name; the second one gets its own file.
        var url = savedDir.appendingPathComponent(safe + ".json")
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = savedDir.appendingPathComponent("\(safe) \(n).json")
            n += 1
        }
        return url
    }

    private func publishSavedConfigs() {
        let entries = savedEntries()
        savedNames = entries.map(\.name)
        rebuildMenu()
        guard let data = try? JSONSerialization.data(withJSONObject: entries.map(\.entry)),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.hudSavedConfigs && window.hudSavedConfigs(\(json))")
    }

    private func saveNamedConfig(_ name: String, _ config: [String: Any]) {
        let entry: [String: Any] = ["name": name, "savedAt": ISO8601DateFormatter().string(from: Date()), "config": config]
        do {
            try FileManager.default.createDirectory(at: savedDir, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(
                withJSONObject: entry,
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try data.write(to: savedFile(for: name), options: .atomic)
        } catch {
            NSLog("usage-hud: could not save config \(name): \(error)")
        }
        publishSavedConfigs()
    }

    private func deleteNamedConfig(_ name: String) {
        for match in savedEntries() where match.name == name {
            try? FileManager.default.removeItem(at: match.url)
        }
        publishSavedConfigs()
    }

    /// Picks up hand edits to the config file without waiting for the next
    /// scheduled refresh.
    private func watchConfig() {
        configStamp = stamp(configPath)
        configTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self, !self.editing else { return }
            let current = self.stamp(configPath)
            if current != self.configStamp {
                self.configStamp = current
                self.refresh()
            }
        }
    }

    // MARK: Refresh loop

    private func schedule() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: refreshInterval, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        timer?.tolerance = refreshInterval * 0.2
    }

    private func refresh() {
        guard !running else { return }
        guard let node = nodePath, let collector = collectorPath else {
            let msg = nodePath == nil
                ? "node not found. Set USAGE_HUD_NODE or reinstall with build.sh."
                : "collect.mjs missing from the app bundle."
            push(json: "{\"ts\":\(Int(Date().timeIntervalSince1970 * 1000)),\"error\":\(quote(msg))}")
            return
        }
        running = true
        webView.evaluateJavaScript("window.hudBusy && window.hudBusy()")

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [collector]
            let out = Pipe()
            let err = Pipe()
            process.standardOutput = out
            process.standardError = err

            var text = ""
            do {
                try process.run()
                let data = out.fileHandleForReading.readDataToEndOfFile()
                let errData = err.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                text = String(data: data, encoding: .utf8) ?? ""
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let e = String(data: errData, encoding: .utf8) ?? "collector produced no output"
                    text = "{\"ts\":\(Int(Date().timeIntervalSince1970 * 1000)),\"error\":\(quote(e))}"
                }
            } catch {
                text = "{\"ts\":\(Int(Date().timeIntervalSince1970 * 1000)),\"error\":\(quote(String(describing: error)))}"
            }

            let line = text.split(separator: "\n").last.map(String.init) ?? text
            DispatchQueue.main.async {
                self?.running = false
                self?.push(json: line)
            }
        }
    }

    private func push(json: String) {
        webView.evaluateJavaScript("window.hudUpdate && window.hudUpdate(\(json))")
        updateStatusTitle(from: json)

        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        if let secs = obj["refreshSeconds"] as? Double, secs >= 5, secs != refreshInterval {
            refreshInterval = secs
            schedule()
        }
        if let config = obj["config"] as? [String: Any] {
            lastConfig = config
            if let theme = config["theme"] as? [String: Any] { applyTheme(theme) }
            let keys = config["hotkeys"] as? [String: Any] ?? [:]
            applyHotkeys([
                "toggle": keys["toggle"] as? String,
                "ghost": keys["ghost"] as? String,
            ])
        }
    }

    /// Mirrors the two headline gauges into the menu bar, so the numbers stay
    /// visible even when the panel is hidden.
    private func updateStatusTitle(from json: String) {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        guard let statusItem else { return }
        if obj["error"] != nil {
            statusItem.button?.title = " !"
            return
        }
        var parts: [String] = []

        // The collector resolves the gauge once, for the panel and for this title.
        if let claude = obj["claude"] as? [String: Any],
           let gauges = claude["gauges"] as? [String: Any],
           let weekly = gauges["weekly"] as? [String: Any],
           let pct = weekly["pct"] as? Double {
            parts.append("C \(Int((pct * 100).rounded()))%")
        }
        if let codex = obj["codex"] as? [String: Any],
           let limits = codex["limits"] as? [String: Any],
           let primary = limits["primary"] as? [String: Any],
           let expired = primary["expired"] as? Bool, !expired,
           let used = primary["usedPercent"] as? Double {
            parts.append("X \(Int(used))%")
        }
        statusItem.button?.title = parts.isEmpty ? "" : " " + parts.joined(separator: " · ")
    }

    // MARK: Web bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        switch action {
        case "ready":
            publishScreenBounds()
            publishSavedConfigs()
            refresh()
        case "refresh":
            refresh()
        case "hide":
            panel.orderOut(nil)
            UserDefaults.standard.set(true, forKey: hiddenKey)
            rebuildMenu()
        case "drag":
            if let event = lastMouseDown, event.type == .leftMouseDown {
                panel.performDrag(with: event)
            }
        case "height":
            if let h = body["value"] as? Double, h > 40 { resize(to: CGFloat(h)) }

        case "theme":
            if let theme = body["theme"] as? [String: Any] { applyTheme(theme) }

        case "saveConfig":
            if let config = body["config"] as? [String: Any] {
                lastConfig = config
                writeConfig(config)
            }

        case "saveNamedConfig":
            if let name = body["name"] as? String, !name.trimmingCharacters(in: .whitespaces).isEmpty,
               let config = body["config"] as? [String: Any] {
                saveNamedConfig(name.trimmingCharacters(in: .whitespaces), config)
            }

        case "deleteNamedConfig":
            if let name = body["name"] as? String { deleteNamedConfig(name) }

        case "resetLayout":
            var config = lastConfig ?? [:]
            config.removeValue(forKey: "cards")
            config.removeValue(forKey: "theme")
            writeConfig(config)
            refresh()

        case "openConfig":
            if !FileManager.default.fileExists(atPath: configPath.path), let config = lastConfig {
                writeConfig(config)
            }
            NSWorkspace.shared.open(configPath)

        case "editing":
            editing = (body["value"] as? Bool) ?? false
            publishScreenBounds()
            setWidth(editing ? 820 : preferredWidth)
            effect.layer?.cornerRadius = editing ? 14 : CGFloat((lastConfig?["theme"] as? [String: Any])?["radius"] as? Double ?? 14)
            // Text fields and pickers need key focus, which a non-activating
            // panel does not take on its own.
            if editing {
                NSApp.activate(ignoringOtherApps: true)
                panel.makeKeyAndOrderFront(nil)
            }
            rebuildMenu()

        default:
            break
        }
    }

    /// Grows or shrinks from the top-left so the panel's visual anchor stays put.
    private func resize(to height: CGFloat) {
        guard height.isFinite else { return }
        let vis = (panel.screen ?? NSScreen.main)?.visibleFrame ?? panel.frame
        let height = min(height, max(1, vis.height - 40))
        var f = panel.frame
        guard abs(f.height - height) > 0.5 else { return }
        f.origin.y += f.height - height
        f.size.height = height
        panel.setFrame(clamped(f), display: true, animate: false)
        saveOrigin()
    }

    // MARK: Geometry

    /// Top-right of the primary screen - the one carrying the menu bar.
    private func defaultOrigin(for size: CGSize) -> NSPoint {
        let vis = (NSScreen.screens.first ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: vis.maxX - size.width - 20, y: vis.maxY - size.height - 20)
    }

    /// A frame counts as usable only if a decent chunk of it lands on a screen.
    /// Checking the origin point alone let the panel sit almost entirely offscreen.
    private func isUsable(_ frame: NSRect) -> Bool {
        for screen in NSScreen.screens {
            let overlap = screen.visibleFrame.intersection(frame)
            if overlap.width >= 140 && overlap.height >= 60 { return true }
        }
        return false
    }

    /// Nudges a frame back onto a screen, preferring the screen it overlaps most.
    private func clamped(_ frame: NSRect) -> NSRect {
        var f = frame
        let best = NSScreen.screens.max {
            $0.visibleFrame.intersection(frame).area < $1.visibleFrame.intersection(frame).area
        }
        let vis = (best ?? NSScreen.screens.first)?.visibleFrame ?? f
        f.size.width = min(f.width, vis.width)
        f.size.height = min(f.height, vis.height)
        f.origin.x = min(max(f.origin.x, vis.minX), max(vis.minX, vis.maxX - f.width))
        f.origin.y = min(max(f.origin.y, vis.minY), max(vis.minY, vis.maxY - f.height))
        return f
    }

    // MARK: Position persistence

    private func publishScreenBounds() {
        guard let panel, let webView else { return }
        let vis = (panel.screen ?? NSScreen.main)?.visibleFrame ?? panel.frame
        webView.evaluateJavaScript("window.hudSetBounds && window.hudSetBounds({height: \(max(160, vis.height - 40))})")
    }

    func windowDidChangeScreen(_ notification: Notification) {
        publishScreenBounds()
        setWidth(editing ? 820 : preferredWidth)
        panel.setFrame(clamped(panel.frame), display: true)
    }

    func windowDidChangeScreenProfile(_ notification: Notification) { publishScreenBounds() }

    func windowDidMove(_ notification: Notification) { saveOrigin() }

    private func saveOrigin() {
        let o = panel.frame.origin
        UserDefaults.standard.set("\(o.x),\(o.y)", forKey: frameKey)
    }

    private func pointFrom(_ s: String) -> NSPoint? {
        let parts = s.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 2 else { return nil }
        return NSPoint(x: parts[0], y: parts[1])
    }

}

private extension NSRect {
    var area: CGFloat { isEmpty ? 0 : width * height }
}

private func quote(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s], options: [])
    guard let data, var str = String(data: data, encoding: .utf8) else { return "\"error\"" }
    str.removeFirst()   // [
    str.removeLast()    // ]
    return str
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
