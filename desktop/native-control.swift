import Cocoa
import ApplicationServices
import CoreGraphics

func fail(_ message: String) -> Never {
    print(String(data: try! JSONSerialization.data(withJSONObject: ["error": message]), encoding: .utf8)!)
    exit(1)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any], let action = request["action"] as? String else { fail("Invalid request") }
func reply(_ value: [String: Any]) { print(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!) }
if action == "status" {
    reply(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "apps": NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { ["id": $0.bundleIdentifier ?? "", "name": $0.localizedName ?? ""] }])
    exit(0)
}
guard let bundle = request["app"] as? String else { fail("Application is missing") }
let foreground = NSWorkspace.shared.frontmostApplication
guard let app = foreground?.bundleIdentifier == bundle ? foreground : NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { fail("Application is not running") }
if action == "focus" { let activated = app.activate(options: []); reply(["ok": activated]); exit(0) }
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { fail("Selected application is no longer in the foreground; focus it again") }
guard AXIsProcessTrusted() else { fail("Enable Accessibility for the native-control helper in System Settings") }
if action == "snapshot" {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    var lines = [String](); var count = 0
    func walk(_ node: AXUIElement, _ depth: Int) {
        if depth > 6 || count >= 300 { return }; count += 1
        var values = [String]()
        for attribute in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(node, attribute as CFString, &value) == .success, let text = value as? String { values.append(String(text.prefix(300))) }
        }
        lines.append(values.joined(separator: " | "))
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &children) == .success, let nodes = children as? [AXUIElement] { for child in nodes { walk(child, depth + 1) } }
    }
    walk(element, 0)
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let window = windows.first { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }
    reply(["text": lines.joined(separator: "\n"), "windowId": window?[kCGWindowNumber as String] ?? 0, "bounds": window?[kCGWindowBounds as String] ?? [:], "screenRecording": CGPreflightScreenCaptureAccess()]); exit(0)
}
let source = CGEventSource(stateID: .hidSystemState)
if action == "click" || action == "move" {
    guard let x = request["x"] as? Double, let y = request["y"] as? Double, x.isFinite, y.isFinite else { fail("Invalid coordinates") }
    let point = CGPoint(x: x, y: y)
    if action == "move" { CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap) }
    else { for type: CGEventType in [.leftMouseDown, .leftMouseUp] { CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap) } }
} else if action == "type" {
    guard let text = request["text"] as? String, text.utf16.count <= 4000 else { fail("Text exceeds 4000 UTF-16 units") }
    let chars = Array(text.utf16)
    for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down); event?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars); event?.post(tap: .cghidEventTap) }
} else if action == "key" {
    let keys: [String: CGKeyCode] = ["enter":36,"tab":48,"escape":53,"backspace":51,"left":123,"right":124,"down":125,"up":126,"a":0,"c":8,"v":9,"x":7,"z":6,"s":1,"f":3]
    guard let name = request["key"] as? String, let key = keys[name] else { fail("Unknown key") }
    var flags: CGEventFlags = []
    for flag in request["modifiers"] as? [String] ?? [] { switch flag { case "command": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "option": flags.insert(.maskAlternate); case "control": flags.insert(.maskControl); default: fail("Unknown modifier") } }
    for down in [true, false] { let event=CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down); event?.flags=flags; event?.post(tap: .cghidEventTap) }
} else if action == "scroll" {
    guard let amount = request["amount"] as? Int32, abs(Int64(amount)) <= 1000 else { fail("Invalid scroll amount") }
    CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: amount, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
} else { fail("Unknown action") }
reply(["ok": true])
