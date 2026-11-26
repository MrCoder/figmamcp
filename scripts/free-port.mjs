// Ask the OS for a currently free TCP port on 127.0.0.1.
//
// CI runs several jobs (and both node-smoke matrix legs) at the same time on
// one self-hosted VM, so a hard-coded port makes one of them fail with
// EADDRINUSE. Binding port 0 makes the kernel hand each caller its own port.
// There is a short window between close() and the caller's own bind(); the
// kernel does not reuse a just-released ephemeral port right away, so the
// clash that matters (two concurrent jobs) cannot happen in practice.
import { createServer } from "node:net";

export function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}
