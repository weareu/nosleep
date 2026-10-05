//
// NoSleepStatus — macOS menu bar app for NoSleep.
//
// One LSUIElement Cocoa app. Polls http://127.0.0.1:3777/health every
// 5s and reflects the result as a coloured dot in the menu bar. The
// drop-down menu has quick actions: open the dashboard, restart the
// server / web LaunchAgents, and quit.
//
// Built as a single binary with SwiftPM, then bundled into a .app
// dir tree by the install script. No dependencies beyond AppKit.
//

import AppKit
import Foundation

// ── Configuration ───────────────────────────────────────────────

let serverHealthURL = URL(string: "http://127.0.0.1:3777/health")!
let webURL = URL(string: "http://127.0.0.1:5173/")!
let pollIntervalSeconds: TimeInterval = 5
let probeTimeoutSeconds: TimeInterval = 4

// LaunchAgent labels. Restart actions call `launchctl kickstart -k`
// against these, mirroring the watchdog's recovery path.
let serverLabel = "com.nosleep.server"
let webLabel = "com.nosleep.web"

// ── Health state ────────────────────────────────────────────────

enum HealthState {
  case unknown
  case ok(activeSessions: Int)
  case down(reason: String)

  /// SF Symbol-free glyph that survives without bundled assets.
  var glyph: String {
    switch self {
    case .unknown: return "◐"
    case .ok: return "●"
    case .down: return "●"
    }
  }

  var menuLine: String {
    switch self {
    case .unknown: return "Server: probing…"
    case .ok(let n): return "Server: healthy (\(n) active session\(n == 1 ? "" : "s"))"
    case .down(let why): return "Server: DOWN — \(why)"
    }
  }
}

// ── App delegate ────────────────────────────────────────────────

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var pollTimer: Timer?
  private var state: HealthState = .unknown {
    didSet { refreshTitle() }
  }

  // Menu items that show live state. Rebuilt instead of mutated to
  // keep the menu small and the logic obvious.
  private let statusMenuItem = NSMenuItem(
    title: "Server: probing…", action: nil, keyEquivalent: ""
  )

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    refreshTitle()
    statusItem.menu = buildMenu()

    // Poll immediately, then on a repeating timer. Fire on a common
    // mode so the timer keeps ticking while menus are open.
    probe()
    pollTimer = Timer(timeInterval: pollIntervalSeconds, repeats: true) { [weak self] _ in
      self?.probe()
    }
    RunLoop.main.add(pollTimer!, forMode: .common)
  }

  // MARK: Menu wiring

  private func buildMenu() -> NSMenu {
    let menu = NSMenu()

    statusMenuItem.isEnabled = false
    menu.addItem(statusMenuItem)
    menu.addItem(.separator())

    menu.addItem(
      makeItem(title: "Open Dashboard", action: #selector(openDashboard))
    )
    menu.addItem(.separator())
    menu.addItem(
      makeItem(title: "Restart Server", action: #selector(restartServer))
    )
    menu.addItem(
      makeItem(title: "Restart Web", action: #selector(restartWeb))
    )
    menu.addItem(
      makeItem(title: "Show Watchdog Log", action: #selector(showWatchdogLog))
    )
    menu.addItem(.separator())
    menu.addItem(
      makeItem(title: "Quit NoSleep Status", action: #selector(quit))
    )

    return menu
  }

  private func makeItem(title: String, action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = self
    return item
  }

  // MARK: Display

  private func refreshTitle() {
    guard let button = statusItem.button else { return }

    // The glyph is the same dot for ok/down — we colour it via an
    // attributed string so the menu bar reads at a glance.
    let glyph = state.glyph
    let colour: NSColor
    switch state {
    case .unknown: colour = .secondaryLabelColor
    case .ok: colour = .systemGreen
    case .down: colour = .systemRed
    }

    let attr = NSMutableAttributedString(string: glyph)
    attr.addAttributes(
      [
        .foregroundColor: colour,
        .font: NSFont.systemFont(ofSize: 13, weight: .bold),
      ],
      range: NSRange(location: 0, length: attr.length)
    )

    button.attributedTitle = attr
    button.toolTip = "NoSleep — \(state.menuLine)"

    statusMenuItem.title = state.menuLine
  }

  // MARK: Health probe

  private func probe() {
    var req = URLRequest(url: serverHealthURL)
    req.timeoutInterval = probeTimeoutSeconds
    let task = URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
      guard let self else { return }

      DispatchQueue.main.async {
        if let error = error as NSError? {
          self.state = .down(reason: error.localizedDescription)
          return
        }
        guard let http = response as? HTTPURLResponse else {
          self.state = .down(reason: "no response")
          return
        }
        if http.statusCode != 200 {
          self.state = .down(reason: "HTTP \(http.statusCode)")
          return
        }
        let activeSessions = Self.parseActiveSessions(data: data)
        self.state = .ok(activeSessions: activeSessions)
      }
    }
    task.resume()
  }

  /// Pluck `activeSessions` out of /health's JSON body without
  /// pulling in a JSON library. Falls back to 0 on parse trouble —
  /// the dot is what users actually read.
  private static func parseActiveSessions(data: Data?) -> Int {
    guard let data = data,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let n = json["activeSessions"] as? Int
    else { return 0 }
    return n
  }

  // MARK: Actions

  @objc private func openDashboard() {
    NSWorkspace.shared.open(webURL)
  }

  @objc private func restartServer() { kick(label: serverLabel) }
  @objc private func restartWeb() { kick(label: webLabel) }

  @objc private func showWatchdogLog() {
    let url = URL(
      fileURLWithPath: NSHomeDirectory()
    ).appendingPathComponent("Library/Logs/nosleep-watchdog.log")
    NSWorkspace.shared.open(url)
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  private func kick(label: String) {
    let uid = String(getuid())
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["kickstart", "-k", "gui/\(uid)/\(label)"]
    do {
      try process.run()
    } catch {
      let alert = NSAlert()
      alert.messageText = "Couldn't restart \(label)"
      alert.informativeText = error.localizedDescription
      alert.alertStyle = .warning
      alert.runModal()
    }
  }
}

// ── Boot ────────────────────────────────────────────────────────

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // Hide from Dock and ⌘-Tab
app.run()
