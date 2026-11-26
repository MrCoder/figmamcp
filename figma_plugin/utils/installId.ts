// One random ID per Figma install, kept in figma.clientStorage, so plugin loads can be
// counted per install. It is made of random hex only: nothing about the person, file or account.
export const INSTALL_ID_PATTERN = /^[0-9a-f]{16}$/;

export interface InstallIdStorage {
    getAsync(key: string): Promise<unknown>;
    setAsync(key: string, value: unknown): Promise<void>;
}

function newInstallId(): string {
    let id = "";
    for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
    return id;
}

export async function loadInstallId(storage: InstallIdStorage): Promise<string | null> {
    try {
        const stored = await storage.getAsync("installId");
        if (typeof stored === "string" && INSTALL_ID_PATTERN.test(stored)) return stored;
        const id = newInstallId();
        await storage.setAsync("installId", id);
        return id;
    } catch (_e) {
        return null;
    }
}
