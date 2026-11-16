// Server configuration from the environment. MCP clients start the server as a child process and
// pass settings as env vars (Claude Code `-e`, Claude Desktop `"env"`), so everything lives here.
//
// This is the plain, local, open variant: a fresh browser on this machine, its own IP, nothing kept
// between runs (no saved logins or site profiles), no proxy, bot-check handling or CAPTCHA solving,
// and no model or API key of its own (the MCP client's model drives the browser). Those live in the
// managed variant (pilotfish's hosted /mcp, packages/mcp-managed).
//
// Secret values are never part of an error message: a malformed PILOTFISH_SECRETS names the entry
// that is wrong, not what it holds (JSON.parse's own message quotes the input, so it is dropped).

import { z } from "zod";
import type { SecretSpec } from "@pilotfish/agent";

export interface McpConfig {
  /** Default: a window wherever one can be shown (hasDisplay), where the person signs in and solves CAPTCHAs; PILOTFISH_HEADLESS=1 hides it. */
  headless: boolean;
  /** Hostname globs every tool may navigate to / act on (PILOTFISH_ALLOWED_HOSTS). Empty = any public host. */
  allowedHosts: string[];
  /** PILOTFISH_ALLOW_PRIVATE=1: allow localhost and private networks (dev). */
  allowPrivateNetwork: boolean;
  /** PILOTFISH_SECRETS: name → value or spec, typed as {{name}} outside any model. */
  secrets: Record<string, SecretSpec>;
  /** How long a tool call waits for the person to answer a question asked in the client (PILOTFISH_INTERVENTION_TIMEOUT_MS). Default 3 min. */
  interventionTimeoutMs: number;
  /** Screenshots are off when secrets are configured (the image would show them) unless PILOTFISH_ALLOW_SCREENSHOTS=1. */
  allowScreenshots: boolean;
}

/** Placeholder names the secret broker substitutes ({{name}}). */
const NAME = /^[a-zA-Z0-9_.-]+$/;
const BASE32 = /^[A-Za-z2-7\s=-]+$/;

const SpecSchema = z
  .object({
    value: z.string().min(1).optional(),
    totp: z.string().regex(BASE32).optional(),
    allowedHosts: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((s) => s.value !== undefined || s.totp !== undefined);

/** Parse PILOTFISH_SECRETS. Throws with a message that names entries but never quotes values. */
export function parseSecrets(raw: string | undefined): Record<string, SecretSpec> {
  if (!raw?.trim()) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("PILOTFISH_SECRETS is not valid JSON (expected an object of name → value or {value?, totp?, allowedHosts?})");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("PILOTFISH_SECRETS must be a JSON object of name → value or {value?, totp?, allowedHosts?}");
  const out: Record<string, SecretSpec> = {};
  for (const [name, spec] of Object.entries(json as Record<string, unknown>)) {
    if (!NAME.test(name)) throw new Error(`PILOTFISH_SECRETS: secret name "${name.slice(0, 40)}" may only use letters, digits, "_", "." and "-"`);
    if (typeof spec === "string") {
      if (!spec) throw new Error(`PILOTFISH_SECRETS: secret "${name}" is empty`);
      out[name] = { value: spec };
      continue;
    }
    const parsed = SpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new Error(`PILOTFISH_SECRETS: secret "${name}" must be a string or {value?: string, totp?: base32 seed, allowedHosts?: string[]} with value or totp set`);
    }
    out[name] = { ...parsed.data, ...(parsed.data.allowedHosts ? { allowedHosts: parsed.data.allowedHosts.map((h) => h.trim().toLowerCase()) } : {}) };
  }
  return out;
}

/** Comma-separated hostname globs → normalized list. */
export function parseHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

/**
 * Whether this machine can show a browser window: Windows and macOS always, Linux with an X or Wayland display. A local
 * MCP's person signs in and solves CAPTCHAs in that window, so it is headed wherever one can be shown.
 */
export function hasDisplay(env: Record<string, string | undefined>, platform: NodeJS.Platform): boolean {
  if (platform === "win32" || platform === "darwin") return true;
  return !!(env["DISPLAY"]?.trim() || env["WAYLAND_DISPLAY"]?.trim());
}

/** Read the whole configuration from an environment (process.env by default). */
export function configFromEnv(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): McpConfig {
  const secrets = parseSecrets(env["PILOTFISH_SECRETS"]);
  const timeout = Number(env["PILOTFISH_INTERVENTION_TIMEOUT_MS"]);
  return {
    // Headed where a window can be shown (4 Nov: headless by default, a login or CAPTCHA the run asked about could not
    // be done by hand until the server was restarted with PILOTFISH_HEADLESS=0); PILOTFISH_HEADLESS=1 hides it.
    headless: flag(env["PILOTFISH_HEADLESS"], !hasDisplay(env, platform)),
    allowedHosts: parseHosts(env["PILOTFISH_ALLOWED_HOSTS"]),
    allowPrivateNetwork: flag(env["PILOTFISH_ALLOW_PRIVATE"], false),
    secrets,
    interventionTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 180_000,
    allowScreenshots: flag(env["PILOTFISH_ALLOW_SCREENSHOTS"], Object.keys(secrets).length === 0),
  };
}
