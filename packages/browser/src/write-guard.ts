// Holding a tab to reading only: its write requests fail, and a world where page-changing calls throw.
// The skill check replays a saved path with writes blocked; `query` runs the model's own expression there.

import type { FrameSession, Page } from "./page.js";
import { RequestInterceptor } from "./intercept.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Fail every write request of the tab, across its main frame AND its cross-origin iframes (each an
 * OOPIF with its own CDP session). Frames that attach meanwhile are armed as they appear: a session
 * initializer scoped to this tab arms each new frame, not just the ones present now. Returns a
 * disposer that removes the initializer and the handlers.
 */
export async function blockPageWrites(tab: Page): Promise<() => void> {
  const block = {
    types: ["Document", "XHR", "Fetch", "Ping", "Other"] as const,
    onRequest: (e: { request: { method: string } }) => (WRITE_METHODS.has(e.request.method) ? { action: "fail" as const, reason: "BlockedByClient" as const } : undefined),
  };
  const regs: Array<{ remove(): void }> = [];
  const arm = (frame: FrameSession) => {
    void frame.session.send("Network.setBypassServiceWorker", { bypass: true }).catch(() => undefined);
    return RequestInterceptor.for(frame.session).add(block);
  };
  // Future frames of THIS tab. addSessionInitializer runs browser-wide, so scope it to this tab and skip the
  // main frame (armed explicitly below so it can be awaited).
  const off = tab.browser.addSessionInitializer(async (frame) => {
    if (frame.page === tab && !frame.isMain) regs.push(arm(frame));
  });
  for (const frame of tab.main.walk()) regs.push(arm(frame));
  await Promise.all(regs.map((r) => (r as { enabled?: Promise<void> }).enabled));
  return () => {
    off();
    for (const r of regs.splice(0)) r.remove();
  };
}

/**
 * Run once in a world of its own (FrameSession.readOnlyWorld): every call that acts on the page, sends
 * data or changes what it shows throws there. Reads (querySelector, innerText, getters, scrolling) work.
 * The page's own scripts never see this world, so nothing here changes how the page behaves for them.
 * `location` cannot be locked (its members are unforgeable): a navigation is caught by the caller instead.
 */
export const READ_ONLY_GUARD = `(() => {
  const refuse = (what) => function () { throw new Error("read-only: " + what + " is not allowed here; act with the click, type, select_option or press tools"); };
  const lock = (obj, key) => { try { if (obj && key in obj) Object.defineProperty(obj, key, { value: refuse(key + "()"), writable: false, configurable: false }); } catch {} };
  const calls = [
    [HTMLElement.prototype, ["click"]],
    [EventTarget.prototype, ["dispatchEvent"]],
    [HTMLFormElement.prototype, ["submit", "requestSubmit", "reset"]],
    [Node.prototype, ["appendChild", "insertBefore", "replaceChild", "removeChild"]],
    [Element.prototype, ["append", "prepend", "after", "before", "replaceWith", "remove", "insertAdjacentElement", "insertAdjacentHTML", "insertAdjacentText", "setAttribute", "setAttributeNS", "removeAttribute", "toggleAttribute", "attachShadow", "setHTMLUnsafe"]],
    [Document.prototype, ["write", "writeln", "open", "execCommand"]],
    [XMLHttpRequest.prototype, ["open", "send"]],
    [Navigator.prototype, ["sendBeacon"]],
    [window, ["fetch", "open", "WebSocket", "EventSource", "postMessage"]],
  ];
  for (const [obj, keys] of calls) for (const k of keys) lock(obj, k);
  const setters = [
    [HTMLInputElement.prototype, ["value", "checked", "files", "valueAsDate", "valueAsNumber"]],
    [HTMLTextAreaElement.prototype, ["value"]],
    [HTMLSelectElement.prototype, ["value", "selectedIndex"]],
    [HTMLOptionElement.prototype, ["selected"]],
    [HTMLFormElement.prototype, ["action"]],
    [Element.prototype, ["innerHTML", "outerHTML"]],
    [HTMLElement.prototype, ["innerText", "outerText"]],
    [Node.prototype, ["textContent", "nodeValue"]],
  ];
  for (const [proto, keys] of setters) for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(proto, k);
    if (d && d.set) try { Object.defineProperty(proto, k, { get: d.get, set: refuse("setting " + k), enumerable: d.enumerable, configurable: false }); } catch {}
  }
  return true;
})()`;
