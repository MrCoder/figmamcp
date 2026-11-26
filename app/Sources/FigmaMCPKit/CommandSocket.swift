import Foundation
import Darwin

/// Listens on a Unix socket. One request per connection: a JSON line in, a JSON line out.
public final class CommandSocket: @unchecked Sendable {
    public typealias Handler = @Sendable (_ command: String) async -> [String: Any]

    public let path: String
    private let handler: Handler
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private let queue = DispatchQueue(label: "figmamcp.socket")

    public init(path: String, handler: @escaping Handler) {
        self.path = path; self.handler = handler
    }

    public static var defaultPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".figmamcp/app.sock")
    }

    public func start() throws {
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        unlink(path)
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { throw posix() }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { close(s); throw posix(ENAMETOOLONG) }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            bytes.withUnsafeBytes { raw.copyMemory(from: $0) }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, len) }
        }
        guard rc == 0 else { let e = posix(); close(s); throw e }
        chmod(path, 0o600) // only this user may talk to the app
        guard listen(s, 8) == 0 else { let e = posix(); close(s); throw e }
        fd = s
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: queue)
        src.setEventHandler { [weak self] in self?.accept() }
        src.resume()
        source = src
    }

    public func stop() {
        source?.cancel(); source = nil
        if fd >= 0 { close(fd); fd = -1 }
        unlink(path)
    }

    private func posix(_ code: Int32 = errno) -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(code)) }

    private func accept() {
        let c = Darwin.accept(fd, nil, nil)
        guard c >= 0 else { return }
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var nosig: Int32 = 1
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &nosig, socklen_t(MemoryLayout<Int32>.size))
        DispatchQueue.global().async { [handler] in
            var data = Data()
            var buf = [UInt8](repeating: 0, count: 1024)
            while data.count < 16_384 {
                let n = recv(c, &buf, buf.count, 0)
                if n <= 0 { break }
                data.append(buf, count: n)
                if data.contains(10) { break }
            }
            Task {
                let reply = await CommandSocket.respond(to: data, handler: handler)
                var out = (try? JSONSerialization.data(withJSONObject: reply)) ?? Data("{\"ok\":false}".utf8)
                out.append(10)
                out.withUnsafeBytes { _ = send(c, $0.baseAddress, out.count, 0) }
                close(c)
            }
        }
    }

    static func respond(to data: Data, handler: Handler) async -> [String: Any] {
        let line = data.split(separator: 10, maxSplits: 1).first.map { Data($0) } ?? data
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let cmd = obj["cmd"] as? String else {
            return ["ok": false, "outcome": "bad-request", "message": "Expected {\"cmd\":\"open-plugin\"}."]
        }
        return await handler(cmd)
    }
}
