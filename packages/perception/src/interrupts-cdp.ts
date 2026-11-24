// Gathers the classifier's inputs from a live Page over CDP: the main-frame
// document response (status + headers), every frame URL (main, same-process
// and out-of-process children, including iframes inside closed shadow roots),
// and the site's cookie names. Uses only Network/Page domains that the Page
// already enables; never Runtime.enable.

import { createHash } from "node:crypto";
import type { Page } from "@pilotfish/browser";
import type { Protocol } from "@pilotfish/cdp";
import { CLEARANCE_COOKIES, type CookieInfo, type InterruptInput, type InterruptSnapshot, type MainResponse } from "./interrupts.js";
import { committedLoader } from "./snapshot.js";

/**
 * gatherInterruptInput was asked to read for one document (`document`) and the page, by its own account, was not on it
 * before or after the whole gather: what was read (address, frames, cookies) may be another document's. `seen`: the
 * page named another document (else it could not say which it was on).
 */
export class DocumentChangedError extends Error {
  constructor(readonly seen: boolean) {
    super(seen ? "the page committed another document during the read" : "the page could not say which document it was on");
    this.name = "DocumentChangedError";
  }
}

export interface MainResponseTracker {
  /**
   * The response (after redirects) of the last main-frame document whose commit the tracker saw. Null before it saw a
   * commit (a response alone is a document still loading, or one that never commits: a 204, a download), and when it
   * saw none for that document.
   */
  readonly latest: MainResponse | null;
  /**
   * The response of the main-frame document with this loaderId (Page.documentId, Snapshot.document): what a look that
   * read that document is classified with, whatever loaded since. Null when the tracker did not see it (attached after
   * it, or no longer kept).
   */
  forDocument(loaderId: string): MainResponse | null;
  dispose(): void;
}

/** Document responses the tracker keeps (a look is a few seconds old at most). */
const TRACKED_DOCS = 16;

/**
 * Remember the main frame's document responses by the document they load (its loaderId). Attach before navigating; the
 * page's session already has Network and Page enabled.
 *
 * A document's response comes in before its commit (3-10 ms locally, longer on a loaded machine), and a look reads the
 * page's elements first and the response after: taken as "the last response", a look at HUMAN's block page as its
 * script reloaded it after a passed hold paired the block page's words with the next document's 200, and read as a
 * Press & Hold to press, with none drawn, instead of HUMAN's block page (fifth review, 17 Nov).
 */
export function trackMainResponse(page: Page): MainResponseTracker {
  const responses = new Map<string, MainResponse>();
  // The last main-frame document committed, by event order.
  let committed: string | null = null;
  const offResponse = page.session.on("Network.responseReceived", (e: Protocol.Network.ResponseReceivedEvent) => {
    if (e.type !== "Document" || e.frameId !== page.main.frameId) return;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.response.headers ?? {})) headers[k.toLowerCase()] = String(v);
    responses.delete(e.loaderId);
    responses.set(e.loaderId, { url: e.response.url, status: e.response.status, headers });
    if (responses.size > TRACKED_DOCS) responses.delete(responses.keys().next().value!);
  });
  const offCommit = page.session.on("Page.frameNavigated", (e: Protocol.Page.FrameNavigatedEvent) => {
    if (e.frame.id === page.main.frameId && !e.frame.parentId) committed = e.frame.loaderId;
  });
  const forDocument = (loaderId: string): MainResponse | null => responses.get(loaderId) ?? null;
  return {
    get latest() {
      return committed ? forDocument(committed) : null;
    },
    forDocument,
    dispose: () => {
      offResponse();
      offCommit();
    },
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
  /**
   * The document the snapshot read (Snapshot.document's loaderId): the tracker's response is that document's. Null: the
   * look is bound to no document, and no response is taken (never the last one by default).
   */
  document?: string | null;
  fedcmDialog?: InterruptInput["fedcmDialog"];
  httpAuthRequired?: InterruptInput["httpAuthRequired"];
}

/** Everything `classifyInterruption` reads, from a live page. Cookie values are reduced to short hashes (clearance cookies only). */
/** The distinct hosts of the document's loaded resources (its Resource Timing entries). */
const RESOURCE_HOSTS = `(() => { const s = new Set(); for (const e of performance.getEntriesByType('resource')) { try { s.add(new URL(e.name).hostname); } catch {} } return [...s]; })()`;

export async function gatherInterruptInput(page: Page, opts: GatherOptions = {}): Promise<InterruptInput> {
  // Read for one document: the page's own account of its committed document must name it before and after the whole
  // read, else nothing read here is that document's for sure (fifth review, v6: Node may hear of a commit only after).
  const bound = typeof opts.document === "string" ? opts.document : null;
  const confirm = async () => {
    if (bound === null) return;
    const now = await committedLoader(page);
    if (now !== bound) throw new DocumentChangedError(now !== undefined);
  };
  await confirm();
  const [frames, cookies, resourceHosts] = await Promise.all([
    frameUrls(page).catch(() => [page.url]),
    page.session
      .send("Network.getCookies", { urls: [page.url] }, { timeoutMs: 3_000 })
      .then((r) => r.cookies.map((c): CookieInfo => (CLEARANCE_COOKIES.includes(c.name) ? { name: c.name, value: hashValue(c.value) } : { name: c.name })))
      .catch(() => [] as CookieInfo[]),
    // The hosts the document loaded from, read in the isolated world (nothing runs in the page's own): a check a script
    // draws in no frame is named by where its puzzle came from (`vendorByResources`).
    Promise.resolve()
      .then(() => page.main.evaluate<string[]>(RESOURCE_HOSTS, { timeoutMs: 1_500 }))
      .then((h) => (Array.isArray(h) ? h.filter((x) => typeof x === "string").slice(0, 300) : []))
      .catch(() => [] as string[]),
  ]);
  const input: InterruptInput = {
    url: page.url,
    frameUrls: frames,
    ...(resourceHosts.length ? { resourceHosts } : {}),
    cookies,
    navigatedAt: page.lastNavigationAt,
    response: opts.response ?? (opts.document !== undefined ? (opts.document ? opts.tracker?.forDocument(opts.document) : null) : opts.tracker?.latest) ?? null,
  };
  await confirm();
  if (opts.snapshot) input.snapshot = opts.snapshot;
  if (opts.fedcmDialog) input.fedcmDialog = opts.fedcmDialog;
  if (opts.httpAuthRequired) input.httpAuthRequired = opts.httpAuthRequired;
  return input;
}
