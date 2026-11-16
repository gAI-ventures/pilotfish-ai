// Gathers the classifier's inputs from a live Page over CDP: the main-frame
// document response (status + headers), every frame URL (main, same-process
// and out-of-process children, including iframes inside closed shadow roots),
// and the site's cookie names. Uses only Network/Page domains that the Page
// already enables; never Runtime.enable.

import { createHash } from "node:crypto";
import type { Page } from "@pilotfish/browser";
import type { Protocol } from "@pilotfish/cdp";
import { CLEARANCE_COOKIES, type CookieInfo, type InterruptInput, type InterruptSnapshot, type MainResponse } from "./interrupts.js";

export interface MainResponseTracker {
  /** The last main-frame document response (after redirects), or null before the first one. */
  readonly latest: MainResponse | null;
  dispose(): void;
}

/**
 * Remember the main frame's latest document response. Attach before
 * navigating; the page's session already has Network enabled.
 */
export function trackMainResponse(page: Page): MainResponseTracker {
  let latest: MainResponse | null = null;
  const off = page.session.on("Network.responseReceived", (e: Protocol.Network.ResponseReceivedEvent) => {
    if (e.type !== "Document" || e.frameId !== page.main.frameId) return;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.response.headers ?? {})) headers[k.toLowerCase()] = String(v);
    latest = { url: e.response.url, status: e.response.status, headers };
  });
  return {
    get latest() {
      return latest;
    },
    dispose: off,
  };
}

/** URLs of every frame in the page, main first. Fragments are kept (hCaptcha puts its frame role there). */
export async function frameUrls(page: Page): Promise<string[]> {
  const seen = new Map<string, string>();
  const walk = (t: Protocol.Page.FrameTree) => {
    const f = t.frame;
    if (!seen.has(f.id)) seen.set(f.id, f.url + (f.urlFragment ?? ""));
    for (const c of t.childFrames ?? []) walk(c);
  };
  const trees = await Promise.all(
    page.frames().map((fs) =>
      fs.session
        .send("Page.getFrameTree", undefined, { timeoutMs: 3_000 })
        .then((r) => r.frameTree)
        .catch(() => null),
    ),
  );
  for (const t of trees) if (t) walk(t);
  // OOPIFs whose session did not answer still have a URL from Target info / frameNavigated.
  for (const fs of page.frames()) if (!seen.has(fs.frameId) && fs.url) seen.set(fs.frameId, fs.url);
  const main = seen.get(page.main.frameId) ?? page.url;
  seen.delete(page.main.frameId);
  return [main, ...seen.values()];
}

const hashValue = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 16);

export interface GatherOptions {
  snapshot?: InterruptSnapshot | null;
  /** The main document response, or a tracker that has been watching the page. */
  response?: MainResponse | null;
  tracker?: MainResponseTracker;
  fedcmDialog?: InterruptInput["fedcmDialog"];
  httpAuthRequired?: InterruptInput["httpAuthRequired"];
}

/** Everything `classifyInterruption` reads, from a live page. Cookie values are reduced to short hashes (clearance cookies only). */
export async function gatherInterruptInput(page: Page, opts: GatherOptions = {}): Promise<InterruptInput> {
  const [frames, cookies] = await Promise.all([
    frameUrls(page).catch(() => [page.url]),
    page.session
      .send("Network.getCookies", { urls: [page.url] }, { timeoutMs: 3_000 })
      .then((r) => r.cookies.map((c): CookieInfo => (CLEARANCE_COOKIES.includes(c.name) ? { name: c.name, value: hashValue(c.value) } : { name: c.name })))
      .catch(() => [] as CookieInfo[]),
  ]);
  const input: InterruptInput = {
    url: page.url,
    frameUrls: frames,
    cookies,
    navigatedAt: page.lastNavigationAt,
    response: opts.response ?? opts.tracker?.latest ?? null,
  };
  if (opts.snapshot) input.snapshot = opts.snapshot;
  if (opts.fedcmDialog) input.fedcmDialog = opts.fedcmDialog;
  if (opts.httpAuthRequired) input.httpAuthRequired = opts.httpAuthRequired;
  return input;
}
