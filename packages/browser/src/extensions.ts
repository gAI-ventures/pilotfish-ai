// How a host plugs its own launch steps into the core launcher (launcher.ts) without the core importing them: a host
// registers one at startup (its exit, browser build and settings, virtual displays). With none registered, launch()
// starts a plain local Chrome, as the open MCP does.

import type { Browser } from "./browser.js";
import type { LaunchOptions } from "./launcher.js";

/** What a launch extension made of the options before Chrome starts (LaunchExtension.prepare). */
export interface PreparedLaunch {
  /** The options to launch with (an extension may set the clock, the locale and the proxy Chrome is given). */
  opts: LaunchOptions;
  /** Right after the Browser is made, before its first page attaches. */
  attach?(browser: Browser): void;
  /** Once the browser is up, before launch() returns it. May close it and throw. */
  ready?(browser: Browser): Promise<void>;
  /** The launch failed: let go of what prepare() started (a local proxy, say). */
  abort?(): Promise<void>;
  /** The launch failed: an error that explains it better than the launch's own (a proxy that refused its login), or null. */
  failure?(): Promise<Error | null>;
}

/** Flags and settings an extension adds when Chrome is spawned (LaunchExtension.spawn). */
export interface LaunchSpawn {
  /** More features for --disable-features (one flag: a second would replace the first). */
  disableFeatures?: string[];
  /** false keeps a headless window's scrollbars (by default they are hidden). */
  hideScrollbars?: boolean;
  /** More flags, after the platform's own and before the user agent, proxy and language (LaunchOptions.args come last). */
  args?: string[];
  /** The browser's own language list (--accept-lang), in place of the one from LaunchOptions.locale. */
  languages?: string;
  /** More environment for the Chrome process. */
  env?: Record<string, string>;
  /** More profile preferences, written with the launch's own before Chrome starts (profile-prefs.ts). */
  prefs?: Record<string, unknown>;
}

/** A virtual display a headed browser opens on (LaunchExtension.startDisplay). */
export interface LaunchDisplay {
  /** The environment Chrome needs to reach it (DISPLAY and the like). */
  env: Record<string, string>;
  close(): void;
}

export interface LaunchExtension {
  /** Before anything starts. Default: the options as given. */
  prepare?(opts: LaunchOptions): Promise<PreparedLaunch>;
  /** The browser to start when the options name none (undefined: find one, see findChromium). */
  executablePath?(opts: LaunchOptions): string | undefined;
  /**
   * The browser's own user agent for a Chrome major, when the extension gives it one (undefined: Chrome's own). Asked
   * before launch with the major of the binary about to start (see chromeVersionOf); unused when `userAgent` is given.
   */
  userAgent?(opts: LaunchOptions): ((chromeMajor: string) => string) | undefined;
  /** Flags, environment and preferences for the Chrome process. */
  spawn?(opts: LaunchOptions, userDataDir: string): LaunchSpawn;
  /** A display for a headed browser on Linux when there is none (no DISPLAY). Default: none, and the launch fails. */
  startDisplay?(size: { width: number; height: number }, screen?: { width: number; height: number }): Promise<LaunchDisplay>;
}

// Kept on globalThis: a process may load this module twice (a package's source and its build output, in tests), and
// both must see the one extension the host registered.
const SLOT = Symbol.for("pilotfish.launchExtension");
type Slot = { [SLOT]?: LaunchExtension | null };

/** Register the launch extension every launch() uses unless its options name one (null: none). */
export function setLaunchExtension(e: LaunchExtension | null): void {
  (globalThis as Slot)[SLOT] = e;
}

/** The registered launch extension, or null. */
export function launchExtension(): LaunchExtension | null {
  return (globalThis as Slot)[SLOT] ?? null;
}
