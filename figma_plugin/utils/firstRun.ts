// First-run hint: show one example prompt until the first successful tool call in this Figma install.
// The flag lives in figma.clientStorage, next to the install ID. If storage fails, the hint stays hidden.
export const FIRST_CALL_KEY = "firstCallDone";

export interface FirstRunStorage {
    getAsync(key: string): Promise<unknown>;
    setAsync(key: string, value: unknown): Promise<void>;
}

export function createFirstRun(storage: FirstRunStorage, post: (pending: boolean) => void) {
    let done = true; // until storage says otherwise
    async function load(): Promise<void> {
        try {
            done = (await storage.getAsync(FIRST_CALL_KEY)) === true;
        } catch (_e) {
            done = true;
        }
        post(!done);
    }
    function noteSuccess(): void {
        if (done) return;
        done = true;
        post(false);
        try { storage.setAsync(FIRST_CALL_KEY, true).catch(() => {}); } catch (_e) { /* best effort */ }
    }
    return { load, noteSuccess };
}
