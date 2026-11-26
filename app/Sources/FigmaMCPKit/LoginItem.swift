import Foundation
import ServiceManagement

public protocol LoginItem: AnyObject {
    var isEnabled: Bool { get }
    func setEnabled(_ on: Bool) throws
}

public final class SystemLoginItem: LoginItem {
    public init() {}
    public var isEnabled: Bool { SMAppService.mainApp.status == .enabled }
    public func setEnabled(_ on: Bool) throws {
        if on { if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() } }
        else { try SMAppService.mainApp.unregister() }
    }
}
