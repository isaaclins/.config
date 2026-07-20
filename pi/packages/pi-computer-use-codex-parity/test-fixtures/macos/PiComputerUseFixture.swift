import AppKit

private enum FixtureAccessibilityIdentifier {
	static let heading = "fixture-heading"
	static let input = "fixture-input"
	static let apply = "fixture-apply"
	static let reset = "fixture-reset"
	static let status = "fixture-status"
}

private final class FixtureAppDelegate: NSObject, NSApplicationDelegate {
	private let inputField = NSTextField(frame: NSRect(x: 24, y: 142, width: 412, height: 28))
	private let statusLabel = NSTextField(labelWithString: "Status: idle")
	private var window: NSWindow?

	func applicationDidFinishLaunching(_ notification: Notification) {
		NSApplication.shared.setActivationPolicy(.regular)

		let contentView = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 250))
		let heading = NSTextField(labelWithString: "Computer Use Fixture")
		heading.frame = NSRect(x: 24, y: 194, width: 412, height: 30)
		heading.font = NSFont.systemFont(ofSize: 22, weight: .semibold)
		heading.setAccessibilityIdentifier(FixtureAccessibilityIdentifier.heading)
		contentView.addSubview(heading)

		inputField.placeholderString = "Fixture input"
		inputField.setAccessibilityLabel("Fixture input")
		inputField.setAccessibilityIdentifier(FixtureAccessibilityIdentifier.input)
		contentView.addSubview(inputField)

		let applyButton = NSButton(title: "Apply", target: self, action: #selector(applyInput))
		applyButton.frame = NSRect(x: 24, y: 92, width: 100, height: 32)
		applyButton.bezelStyle = .rounded
		applyButton.setAccessibilityIdentifier(FixtureAccessibilityIdentifier.apply)
		contentView.addSubview(applyButton)

		let resetButton = NSButton(title: "Reset", target: self, action: #selector(resetFixture))
		resetButton.frame = NSRect(x: 136, y: 92, width: 100, height: 32)
		resetButton.bezelStyle = .rounded
		resetButton.setAccessibilityIdentifier(FixtureAccessibilityIdentifier.reset)
		contentView.addSubview(resetButton)

		statusLabel.frame = NSRect(x: 24, y: 42, width: 412, height: 24)
		statusLabel.setAccessibilityLabel("Fixture status")
		statusLabel.setAccessibilityIdentifier(FixtureAccessibilityIdentifier.status)
		contentView.addSubview(statusLabel)

		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 460, height: 250),
			styleMask: [.titled, .closable],
			backing: .buffered,
			defer: false
		)
		window.title = "Pi Computer Use Fixture"
		window.contentView = contentView
		window.isReleasedWhenClosed = false
		window.center()
		window.makeKeyAndOrderFront(nil)
		self.window = window
		NSApplication.shared.activate(ignoringOtherApps: true)
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
		true
	}

	@objc private func applyInput() {
		statusLabel.stringValue = "Status: applied:\(inputField.stringValue)"
	}

	@objc private func resetFixture() {
		inputField.stringValue = ""
		statusLabel.stringValue = "Status: idle"
	}
}

@main
private enum PiComputerUseFixtureApp {
	static func main() {
		let application = NSApplication.shared
		let delegate = FixtureAppDelegate()
		application.delegate = delegate
		withExtendedLifetime(delegate) {
			application.run()
		}
	}
}
