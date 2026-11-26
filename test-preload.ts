// Loaded before every test file (bunfig.toml). The site worker copies each pixel count to
// Mixpanel, and many tests call the worker with the real fetch. Without this guard every
// test run, local or CI, would add events to the production Mixpanel project.
const realFetch = globalThis.fetch;
const g = globalThis as typeof globalThis & { __mixpanelBlocked?: number };
g.__mixpanelBlocked = 0;
const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).hostname.endsWith("mixpanel.com")) {
    g.__mixpanelBlocked = (g.__mixpanelBlocked ?? 0) + 1;
    throw new Error(`Mixpanel request blocked in tests: ${url}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = Object.assign(guarded, realFetch);
