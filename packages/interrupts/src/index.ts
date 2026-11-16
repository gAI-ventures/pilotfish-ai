// @pilotfish/interrupts — cookie-consent banners and ads/trackers handled deterministically,
// with maintained rule sets and no model call.
export { attachInterrupts } from "./attach.js";
export type { InterruptOptions, InterruptEvent, Interrupts } from "./attach.js";
export { ConsentEngine, OPT_IN_SNIPPETS } from "./consent.js";
export type { ConsentOptions, ConsentOutcome, ConsentStatus, ConsentEvents } from "./consent.js";
export { AdBlockEngine } from "./adblock.js";
export type { AdBlockOptions, AdBlockStats, AdBlockEvents } from "./adblock.js";
export { loadLists, buildEngine, deriveTierA, defaultCacheDir, httpText, UPSTREAM_LISTS } from "./lists.js";
export type { TierA, LoadedLists, ListSource, LoadListsOptions, FetchText } from "./lists.js";
export { NEVER_BLOCK, CHALLENGE_HOSTS, PAYMENT_HOSTS, AUTH_HOSTS, CMP_HOSTS, PAYWALL_HOSTS, isNeverBlocked, isCmpRequest } from "./hosts.js";
