// attachInterrupts: one session initializer that arms consent handling and ad blocking on every
// frame session (tabs and out-of-process iframes) before the frame's scripts run.

import type { Browser, FrameSession } from "@pilotfish/browser";
import { AdBlockEngine, type AdBlockEvents, type AdBlockOptions } from "./adblock.js";
import { ConsentEngine, type ConsentEvents, type ConsentOptions } from "./consent.js";

export interface InterruptOptions {
  /** Cookie-consent handling (reject only). Default true. */
  consent?: boolean | ConsentOptions;
  /** Ad and tracker blocking. Default true; `{ tierB: true }` adds exact Fetch-based matching. */
  adblock?: boolean | AdBlockOptions;
  /** Every engine event, tagged with its source. */
  onEvent?: (event: InterruptEvent) => void;
}

export type InterruptEvent =
  | { [E in keyof ConsentEvents]: { source: "consent"; type: E; data: Parameters<ConsentEvents[E]>[0] } }[keyof ConsentEvents]
  | { [E in keyof AdBlockEvents]: { source: "adblock"; type: E; data: Parameters<AdBlockEvents[E]>[0] } }[keyof AdBlockEvents];

export interface Interrupts {
  consent: ConsentEngine | null;
  adblock: AdBlockEngine | null;
  /** Stop arming new sessions and undo what was installed on existing ones (best effort). */
  detach(): void;
}

const CONSENT_EVENTS: Array<keyof ConsentEvents> = ["cmpDetected", "popupFound", "optOutResult", "autoconsentDone", "selfTestResult", "error"];
const ADBLOCK_EVENTS: Array<keyof AdBlockEvents> = ["blocked", "error"];

/**
 * Arm `browser`. Resolves once the ad-block engine is loaded (from the on-disk cache in ~0.1 s;
 * the first run fetches and builds the lists, a few seconds). Pages already open are armed too,
 * though their current documents miss the init scripts until they navigate.
 */
export async function attachInterrupts(browser: Browser, opts: InterruptOptions = {}): Promise<Interrupts> {
  const consent = opts.consent === false ? null : new ConsentEngine(typeof opts.consent === "object" ? opts.consent : {});
  const adblock = opts.adblock === false ? null : await AdBlockEngine.create(typeof opts.adblock === "object" ? opts.adblock : {});
  const offs: Array<() => void> = [];
  if (opts.onEvent) {
    const emit = opts.onEvent;
    if (consent) for (const type of CONSENT_EVENTS) offs.push(consent.on(type, ((data: never) => emit({ source: "consent", type, data } as InterruptEvent)) as never));
    if (adblock) for (const type of ADBLOCK_EVENTS) offs.push(adblock.on(type, ((data: never) => emit({ source: "adblock", type, data } as InterruptEvent)) as never));
  }
  const init = async (frame: FrameSession): Promise<void> => {
    await Promise.all([consent?.initSession(frame), adblock?.initSession(frame)]);
  };
  offs.push(browser.addSessionInitializer(init));
  return {
    consent,
    adblock,
    detach() {
      for (const o of offs) o();
      consent?.dispose();
      adblock?.dispose();
    },
  };
}
