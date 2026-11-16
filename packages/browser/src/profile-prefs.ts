// What the launcher writes into a Chrome profile before Chrome starts: profile prefs Chrome has no switch
// for, and the (empty) on-device model manifest config Chrome is pointed at.
//
// net.network_prediction_options = 2 ("Preload pages" off): Chrome otherwise preconnects to a navigation's
// origin (and to the default search engine at startup) before the document request reaches the Fetch
// interceptor that routes a joining site ('main'/'all'/'frames', a pinned site). That CONNECT is decided
// direct, so the site would see a TCP and TLS handshake from this machine just before its document came
// through the proxy, and the proxy's connection could even resume that TLS session. With
// prediction off, a navigation's first connection is opened after its document is paused and its site
// routed. It also stops prefetch and prerender (speculation rules), so nothing loads that the run did
// not ask for. Pages cannot read the setting; a site only sees no speculative traffic, as with many users.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Profile prefs every launched profile gets (merged into an existing Preferences file). */
export const PROFILE_PREFS = { net: { network_prediction_options: 2 } } as const;

/** File name (in the user data dir) of the empty config --optimization-guide-manifest-override points at. */
export const MODEL_MANIFEST_OVERRIDE = "pilotfish-model-manifest.json";

/**
 * The profile directory Chrome opens: the last --profile-directory switch, else the profile the user data
 * dir's Local State says was used last (a kept user data dir may have several), else "Default". A last_used
 * of "System Profile" (Chrome never writes it; a hand-edited Local State) opens Default, so it does not count.
 */
export function profileDirectory(args: readonly string[], userDataDir?: string): string {
  let dir = "";
  for (const a of args) if (a.startsWith("--profile-directory=")) dir = a.slice("--profile-directory=".length).replace(/^"|"$/g, "") || dir;
  if (dir) return dir;
  try {
    const last: unknown = userDataDir ? (JSON.parse(readFileSync(join(userDataDir, "Local State"), "utf8")) as { profile?: { last_used?: unknown } })?.profile?.last_used : undefined;
    if (typeof last === "string" && last && !/[\\/]|^\.\.?$|^System Profile$/.test(last)) return last;
  } catch {
    /* no Local State (a new user data dir), or one Chrome will rewrite: Chrome starts on Default */
  }
  return "Default";
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** `base` with every leaf of `over` set in it (objects merged key by key, anything else replaced). */
function merged(base: { [k: string]: Json }, over: { readonly [k: string]: unknown }): { [k: string]: Json } {
  const out: { [k: string]: Json } = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merged(cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {}, v as { [k: string]: unknown }) : (v as Json);
  }
  return out;
}

/**
 * Write PROFILE_PREFS into the profile's Preferences (created when missing, merged into an existing one so a
 * kept profile keeps everything else) and the empty model-manifest config. Returns false when the prefs
 * could not be set: an existing Preferences file that is not valid JSON is left for Chrome to deal with
 * (rewriting it here could lose the profile's settings), and a write error is reported the same way.
 */
export function seedProfile(userDataDir: string, args: readonly string[] = [], extra?: { readonly [k: string]: unknown }): boolean {
  try {
    const manifest = join(userDataDir, MODEL_MANIFEST_OVERRIDE);
    if (!existsSync(manifest)) writeFileSync(manifest, "{}\n");
    const dir = join(userDataDir, profileDirectory(args, userDataDir));
    const file = join(dir, "Preferences");
    let prefs: { [k: string]: Json } = {};
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      prefs = parsed as { [k: string]: Json };
    } else mkdirSync(dir, { recursive: true });
    const next = merged(merged(prefs, PROFILE_PREFS), extra ?? {});
    if (JSON.stringify(next) !== JSON.stringify(prefs)) writeFileSync(file, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
