// Signing the relay in without an API key: the OAuth device flow (RFC 8628). `pilotfish-mcp-managed login` asks
// pilotfish for a short code, the person opens pilotfish's page on any device (a phone will do: nothing has to run
// in this machine's browser), signs in and allows it, and the relay keeps the tokens in a file only its user can
// read. The access token lasts an hour; the relay refreshes it by itself. Refresh tokens rotate and a reused one
// ends the whole sign-in, so two relays on one machine (two Claude Code windows) refresh under a file lock and
// take each other's new tokens rather than both spending the same one.

import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { endpointOf } from "./bridge.js";

/** The relay's OAuth client at pilotfish (public; device flow only). */
export const CLI_CLIENT_ID = "pilotfish-cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Refresh this long before the access token runs out. */
const EARLY_MS = 60_000;

export interface SavedSignIn {
  /** The pilotfish API the tokens are for (its base, no /mcp). */
  url: string;
  access_token: string;
  refresh_token: string;
  /** Epoch ms the access token runs out. */
  expires_at: number;
}

/** Where the sign-in is kept: PILOTFISH_TOKEN_FILE, else ~/.pilotfish/mcp-managed.json. */
export function tokenFileOf(env: NodeJS.ProcessEnv = process.env): string {
  return env["PILOTFISH_TOKEN_FILE"]?.trim() || join(homedir(), ".pilotfish", "mcp-managed.json");
}

/** `https://host/mcp` or `https://host` → `https://host` (the OAuth endpoints' base). */
export function apiBaseOf(url: string): string {
  return endpointOf(url).href.replace(/\/mcp\/?$/, "");
}

type Fetch = typeof fetch;

async function form(f: Fetch, url: string, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(body).toString() });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

export async function readSaved(file: string): Promise<SavedSignIn | null> {
  try {
    const s = JSON.parse(await readFile(file, "utf8")) as SavedSignIn;
    return typeof s.access_token === "string" && typeof s.refresh_token === "string" && typeof s.url === "string" ? s : null;
  } catch {
    return null;
  }
}

async function writeSaved(file: string, s: SavedSignIn): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  // A rename replaces the file whole: a relay reading it never sees half of it.
  await rename(tmp, file);
}

const tokensFrom = (url: string, j: Record<string, unknown>): SavedSignIn => {
  if (typeof j["access_token"] !== "string" || typeof j["refresh_token"] !== "string") throw new Error("pilotfish answered the sign-in without tokens");
  return { url, access_token: j["access_token"], refresh_token: j["refresh_token"], expires_at: Date.now() + Number(j["expires_in"] ?? 3600) * 1000 };
};

export interface LoginOptions {
  url: string;
  file: string;
  /** Where the instructions go (stderr in the CLI). */
  say: (line: string) => void;
  fetch?: Fetch;
  /** Waits between polls (tests make it short). */
  sleep?: (ms: number) => Promise<void>;
}

/** The device flow: show the code, wait for the person to allow it, keep the tokens. */
export async function deviceLogin(o: LoginOptions): Promise<SavedSignIn> {
  const f = o.fetch ?? fetch;
  const base = apiBaseOf(o.url);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = await form(f, `${base}/oauth/device_authorization`, { client_id: CLI_CLIENT_ID, scope: "pilotfish" });
  if (start.status !== 200) throw new Error(`pilotfish refused to start a sign-in: ${String(start.json["error_description"] ?? start.json["error"] ?? start.status)}`);
  const j = start.json as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number };
  o.say(`To sign in, open ${j.verification_uri_complete ?? j.verification_uri}`);
  o.say(`and check that it shows the code ${j.user_code} (or open ${j.verification_uri} and type it).`);
  o.say(`Waiting for you to allow it (the code works for ${Math.round(j.expires_in / 60)} minutes)...`);
  let interval = Math.max(1, j.interval ?? 5) * 1000;
  const until = Date.now() + j.expires_in * 1000;
  while (Date.now() < until) {
    await sleep(interval);
    const r = await form(f, `${base}/oauth/token`, { grant_type: DEVICE_GRANT, device_code: j.device_code, client_id: CLI_CLIENT_ID });
    if (r.status === 200) {
      const saved = tokensFrom(base, r.json);
      await writeSaved(o.file, saved);
      return saved;
    }
    const err = String(r.json["error"] ?? "");
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5_000;
      continue;
    }
    if (err === "access_denied") throw new Error("The sign-in was denied on pilotfish's page.");
    if (err === "expired_token") break;
    throw new Error(`pilotfish refused the sign-in: ${String(r.json["error_description"] ?? (err || r.status))}`);
  }
  throw new Error("The code expired before it was allowed. Run login again.");
}

/** Sign this machine out: the refresh token revoked at pilotfish (best effort), the file removed. */
export async function logout(file: string, f: Fetch = fetch): Promise<boolean> {
  const s = await readSaved(file);
  if (!s) return false;
  await form(f, `${s.url}/oauth/revoke`, { token: s.refresh_token, client_id: CLI_CLIENT_ID }).catch(() => undefined);
  await form(f, `${s.url}/oauth/revoke`, { token: s.access_token, client_id: CLI_CLIENT_ID }).catch(() => undefined);
  await rm(file, { force: true });
  return true;
}

/** Holds `file + ".lock"` while `fn` runs; a lock left by a crashed relay (over 30 s old) is taken over. */
async function locked<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    try {
      const h = await open(lock, "wx", 0o600);
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
      if (age > 30_000) await rm(lock, { force: true });
      else if (i > 200) throw new Error(`Another pilotfish relay holds ${lock}: remove it if no relay is running.`);
      else await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/** The access token for each request, refreshed before it runs out (and once more when pilotfish says 401). */
export class TokenSource {
  private current: SavedSignIn;
  private refreshing: Promise<void> | null = null;

  constructor(
    saved: SavedSignIn,
    private readonly file: string,
    private readonly f: Fetch = fetch,
  ) {
    this.current = saved;
  }

  get url(): string {
    return this.current.url;
  }

  async token(): Promise<string> {
    if (Date.now() > this.current.expires_at - EARLY_MS) await this.refresh(this.current.access_token);
    return this.current.access_token;
  }

  /** A new access token unless someone (this relay, or another under the lock) already replaced `stale`. */
  refresh(stale: string): Promise<void> {
    this.refreshing ??= locked(this.file, async () => {
      // Another relay may have refreshed meanwhile: its tokens are ours too (ours were rotated away).
      const onDisk = await readSaved(this.file);
      if (onDisk && onDisk.access_token !== stale && onDisk.expires_at > Date.now() + EARLY_MS) {
        this.current = onDisk;
        return;
      }
      const from = onDisk ?? this.current;
      const r = await form(this.f, `${from.url}/oauth/token`, { grant_type: "refresh_token", refresh_token: from.refresh_token, client_id: CLI_CLIENT_ID });
      if (r.status !== 200) throw new Error(`pilotfish ended this sign-in (${String(r.json["error_description"] ?? r.json["error"] ?? r.status)}). Run: npx @gaiventures/pilotfish-mcp-managed login`);
      this.current = tokensFrom(from.url, r.json);
      await writeSaved(this.file, this.current);
    }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** A fetch for the MCP transport: the bearer token on every request, one retry after a refresh on 401. */
  fetch(): Fetch {
    return async (input, init) => {
      const send = async (token: string) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return this.f(input, { ...init, headers });
      };
      const token = await this.token();
      const r = await send(token);
      if (r.status !== 401) return r;
      await this.refresh(token);
      return send(this.current.access_token);
    };
  }
}
