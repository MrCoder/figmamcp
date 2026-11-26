import XCTest
import AppKit
@testable import FigmaMCPKit

final class AppPresenceTests: XCTestCase {
    func testSetupWindowAppearsInCommandTab() {
        XCTAssertEqual(AppPresence.policy(setupWindowOpen: true), .regular)
    }

    func testMenuBarOnlyWhenNoWindowIsOpen() {
        XCTAssertEqual(AppPresence.policy(setupWindowOpen: false), .accessory)
    }
}
