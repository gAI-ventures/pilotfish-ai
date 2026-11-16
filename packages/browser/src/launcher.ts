// Browser launcher: finds a Chromium-family binary, spawns it with a hygienic
// flag set, and attaches a CDP Connection over the remote-debugging pipe.
//
// Why the pipe and not a port: `--remote-debugging-pipe` opens no TCP listener,
// so nothing else on the host (including untrusted pages triggering SSRF) can
// attach to the browser. A hosting application that serves remote clients
// re-exposes CDP over an authenticated WebSocket of its own.
//
// Why these flags: we never pass
// `--enable-automation` (it sets navigator.webdriver and the infobar), we do
// pass `--disable-blink-features=AutomationControlled`, and we leave Runtime
// un-enabled in the client. Everything else is about determinism: no first-run
// UI, no background networking, no component updates, fixed window size, and
// none of Chrome's own requests at startup but one it has no switch for (the
// signed-out account check, accounts.google.com/ListAccounts), nor its
// speculative preconnects ("Preload pages" off in the profile, profile-prefs.ts).
// That is Google Chrome's startup. A Chrome for Testing build (the Docker image
// runs Playwright's; seen on chromium-1208) also starts push messaging (GCM)
// within seconds: android.clients.google.com check-in and registration, then
// mtalk.google.com:5228.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Connection, PipeTransport, WebSocketTransport, type ConnectionOptions } from "@pilotfish/cdp";
import { Browser, proxyHasCredentials } from "./browser.js";
import { CHROME_SERVICE_HOSTS } from "./network.js";
import { launchExtension, type LaunchDisplay, type LaunchExtension, type LaunchSpawn, type PreparedLaunch } from "./extensions.js";
import { MODEL_MANIFEST_OVERRIDE, seedProfile } from "./profile-prefs.js";

export interface LaunchOptions {
  /** Explicit executable. Else $PILOTFISH_CHROME, then auto-detect. */
  executablePath?: string;
  /** Default true. Headed under Xvfb is preferred for fidelity on servers. */
  headless?: boolean;
  /** Viewport / window size. Default 1280x800 (fits Claude's recommended screenshot size). */
  viewport?: { width: number; height: number };
  /**
   * Headed on a virtual display: the display's size (the screen the launch reports), so CSS device-width/height
   * and screen.* agree. Used only when the window (its outer size) fits on it (see xvfbScreen).
   */
  screen?: { width: number; height: number };
  /** Persist a profile here instead of a throwaway temp dir. */
  userDataDir?: string;
  /** Extra Chromium flags appended last (override ours). */
  args?: string[];
  /**
   * Launch-time proxy, e.g. "http://host:port" or "socks5://host:port". An http proxy with
   * credentials ("http://user:pass@host:port") goes through a local forwarder that adds them
   * (Chromium ignores credentials in --proxy-server).
   */
  proxyServer?: string;
  /** Hosts that bypass the proxy. */
  proxyBypass?: string[];
  /** Language for Accept-Language and navigator.language, e.g. "en-US". */
  locale?: string;
  /**
   * Timezone ID, e.g. "America/New_York". Applied to every frame session, and every shared and service worker
   * session, via Emulation (Browser.applyClock); also the browser process's TZ on Linux and macOS.
   */
  timezoneId?: string;
  /** Downloads directory. Default: <userDataDir>/downloads. */
  downloadsPath?: string;
  /** Ignore TLS errors (testing only). */
  ignoreHTTPSErrors?: boolean;
  /** Dump the raw CDP wire to stderr. */
  debugWire?: boolean;
  connection?: ConnectionOptions;
  /** Milliseconds to wait for the browser to come up. Default 30s. */
  launchTimeoutMs?: number;
  /** Pipe Chrome's stderr to ours (noisy; useful for crashes). */
  dumpio?: boolean;
  /**
   * The browser's own user agent (--user-agent): what requests and contexts no session override reaches
   * report — the script fetch that starts a service worker or a nested worker, a service worker's update
   * checks, a shared or service worker's navigator.userAgent. An extension may set it (LaunchExtension.userAgent).
   */
  userAgent?: string;
  /**
   * The launch extension for this launch (extensions.ts): null for none, undefined for the one registered
   * (setLaunchExtension), if any.
   */
  extension?: LaunchExtension | null;
}

/** Google Chrome stable, installed system-wide (or, on Windows, per user): what CI and the servers run. */
function googleChromeCandidates(os: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (os === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  if (os === "linux") return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
  return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : []),
  ];
}

/** Other Chromium-family browsers, when there is no Google Chrome. */
function otherChromiumCandidates(os: NodeJS.Platform): string[] {
  if (os === "darwin") return ["/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"];
  if (os === "linux") return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"];
}

/** Playwright's browser cache: Chrome for Testing builds, pinned (they never update themselves). */
function playwrightChromiumCandidates(os: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string[] {
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    os === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : undefined,
    os === "linux" ? join(homedir(), ".cache/ms-playwright") : undefined,
    os === "win32" ? join(env.LOCALAPPDATA ?? "", "ms-playwright") : undefined,
  ].filter((r): r is string => !!r && exists(r));
  const out: string[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Prefer the full browser over the headless shell: the shell is a lighter
    // //content wrapper that differs from Chrome and lacks features.
    const chromiumDirs = entries.filter((e) => /^chromium-\d+$/.test(e)).sort().reverse();
    for (const d of chromiumDirs) {
      const base = join(root, d);
      out.push(
        join(base, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        join(base, "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        join(base, "chrome-linux/chrome"),
        join(base, "chrome-linux64/chrome"),
        join(base, "chrome-win/chrome.exe"),
        join(base, "chrome-win64/chrome.exe"),
      );
    }
  }
  return out;
}

/**
 * The browser to launch: $PILOTFISH_CHROME, else Google Chrome stable, else a Playwright Chrome for Testing
 * build, else another Chromium-family browser. Google Chrome comes first because it is what CI and the
 * servers run, and it updates itself: a cached Chrome for Testing build ages, and Chrome changes how it
 * behaves with a build's age (past about ten weeks it stops enforcing its built-in HSTS preload list, so
 * an http:// frame on challenges.cloudflare.com stays http), which hid a CI failure from local runs.
 */
export function findChromium(o: { env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean; os?: NodeJS.Platform } = {}): string | undefined {
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const os = o.os ?? platform();
  const chosen = env.PILOTFISH_CHROME;
  if (chosen && exists(chosen)) return chosen;
  for (const c of [...googleChromeCandidates(os, env), ...playwrightChromiumCandidates(os, env, exists), ...otherChromiumCandidates(os)]) {
    if (exists(c)) return c;
  }
  return undefined;
}

export function defaultArgs(opts: LaunchOptions, userDataDir: string, extra: LaunchSpawn = {}): string[] {
  const { width, height } = opts.viewport ?? { width: 1280, height: 800 };
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-client-side-phishing-detection",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-search-engine-choice-screen",
    "--disable-session-crashed-bubble",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    "--mute-audio",
    "--disable-infobars",
    "--disable-blink-features=AutomationControlled",
    // The last three are Chrome's own requests at startup, before any page (Chrome 156): the omnibox's AI Mode
    // check (www.google.com/async/folae), Safe Browsing's real-time lookup key (www.gstatic.com; Safe Browsing
    // keeps its local lists, which --disable-background-networking may already keep from updating: not
    // verified) and the network clock (clients2.google.com). www.google.com and www.gstatic.com are
    // hosts pages use too (reCAPTCHA among them), so they cannot bypass the proxy: through it they ride the paid
    // exit whenever any site is routed (CHECK_SERVICE_HOSTS).
    // An extension may disable more (LaunchSpawn.disableFeatures): a second --disable-features would replace this one.
    `--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,DestroyProfileOnBrowserClose,HttpsUpgrades,PrivacySandboxSettings4,LensOverlay,AimEnabled,SafeBrowsingHashPrefixRealTimeLookups,NetworkTimeServiceQuerying${extra.disableFeatures?.length ? `,${extra.disableFeatures.join(",")}` : ""}`,
    "--enable-features=NetworkService,NetworkServiceInProcess2",
    // The on-device model manifest registers itself with the component updater and installs at every start
    // (update.googleapis.com, edgedl.me.gvt1.com) despite --disable-component-update. An empty override config
    // (written by launch(), see profile-prefs.ts) means no manifest: the built-in AI APIs report unavailable.
    // The trade-off: on a host Chrome would find eligible for the on-device model, a page can read that
    // LanguageModel and the like are "unavailable" where a desktop with a GPU could have them. Measured on the GPU-less CI runner (LanguageModel, Summarizer and LanguageDetector
    // "unavailable", Translator "downloadable"), and on Windows Chrome 156 headless with and without the flag
    // (the review): the same availability both ways (Writer, Rewriter and Proofreader absent too), so no
    // page-visible difference was seen there. Headed runs and hosts with a GPU are not measured.
    `--optimization-guide-manifest-override=${join(userDataDir, MODEL_MANIFEST_OVERRIDE)}`,
  ];
  // Headless hides scrollbars unless an extension keeps them (LaunchSpawn.hideScrollbars).
  if (opts.headless !== false) args.push("--headless=new", ...(extra.hideScrollbars === false ? [] : ["--hide-scrollbars"]));
  // Headed, Chrome puts a bar over every page for a flag it calls unsupported ("You are using an unsupported
  // command-line flag: ..."; --enable-unsafe-swiftshader below is one): 56 px off the page, a window 143 px taller
  // than its page where a desktop Chrome's is 85-90, and a yellow band in the live view and every screenshot (on
  // every headed session that passes such a flag). --test-type is what keeps that bar away (Chrome's own test harnesses
  // pass it); a page sees nothing of it.
  else args.push("--test-type");
  if (platform() === "linux") args.push("--disable-dev-shm-usage");
  // Headed on Linux, a server's virtual display (Xvfb) has no GPU, and Chrome no longer falls back to its
  // software renderer (SwiftShader) for WebGL by itself: on Chrome 156 the page and its workers had no WebGL
  // or WebGL2 at all, which no desktop browser lacks (a bot signal on its own, and maps and canvas-heavy
  // sites break). Headless Chrome renders WebGL with that same SwiftShader already, so this gives the headed
  // browser what every headless run has had, no more. The trade-off, accepted for both: SwiftShader runs
  // untrusted shaders through a JIT in the GPU process, a weaker boundary than a hardware driver, which is
  // why Chrome made it opt-in; the GPU and renderer sandboxes stay on. Only used where no GPU answers, so a
  // Linux desktop with a working GPU renders WebGL on it as before.
  if (opts.headless === false && platform() === "linux") args.push("--enable-unsafe-swiftshader");
  // An extension's own flags (LaunchSpawn.args).
  if (extra.args?.length) args.push(...extra.args);
  // The browser's own user agent (LaunchOptions.userAgent): what no session override reaches.
  if (opts.userAgent) args.push(`--user-agent=${opts.userAgent}`);
  if (opts.proxyServer) args.push(`--proxy-server=${opts.proxyServer}`);
  if (opts.proxyServer) args.push(`--proxy-bypass-list=${[...CHROME_SERVICE_HOSTS, ...(opts.proxyBypass ?? [])].join(";")}`);
  // --lang alone falls back to a UI locale Chrome ships (en-IN became en-GB); --accept-lang sets
  // navigator.languages and the Accept-Language header to the exact locale. An extension may give the browser a
  // language list of its own (LaunchSpawn.languages).
  if (opts.locale) args.push(`--lang=${opts.locale}`);
  const languages = extra.languages ?? (opts.locale ? acceptLanguage(opts.locale) : undefined);
  if (languages) args.push(`--accept-lang=${languages}`);
  if (opts.ignoreHTTPSErrors) args.push("--ignore-certificate-errors");
  args.push(...(opts.args ?? []));
  args.push("about:blank");
  return args;
}

/** Versions read per executable (Windows), keyed on its size and modified time so an updated binary is read again. */
const versionCache = new Map<string, { stamp: string; version: string | null }>();

/** The newest dotted version among names like "156.0.8078.74" or "151.0.7922.34.manifest", or null. */
export function newestVersionName(names: string[]): string | null {
  const versions = names.map((n) => /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\.manifest)?$/.exec(n)).filter((m): m is RegExpExecArray => !!m);
  versions.sort((a, b) => {
    for (let i = 1; i <= 4; i++) if (Number(a[i]) !== Number(b[i])) return Number(b[i]) - Number(a[i]);
    return 0;
  });
  const top = versions[0];
  return top ? `${top[1]}.${top[2]}.${top[3]}.${top[4]}` : null;
}

/**
 * The version of the Chromium at `executablePath` without starting a browser: `--version` on Linux and
 * macOS ("Google Chrome 156.0.8078.47"), run at every call: the path is often a wrapper script that stays the
 * same file when the Chrome it starts is upgraded, so nothing
 * about it says when to read again. On Windows, where chrome.exe prints nothing, the versioned folder (an
 * install: Application\156.0.8078.74\) or manifest (Chrome for Testing: 151.0.7922.34.manifest) beside it,
 * cached per executable until chrome.exe changes (an update rewrites it). null when it cannot tell.
 */
export async function chromeVersionOf(executablePath: string): Promise<string | null> {
  let stamp = "";
  try {
    const st = statSync(executablePath);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    // A bare command name ("chromium") is found on PATH, by the spawn and by --version alike; not on Windows,
    // where the version is read beside the binary.
    if (process.platform === "win32" || /[\\/]/.test(executablePath)) return null;
  }
  if (process.platform !== "win32") {
    return new Promise<string | null>((resolve) => {
      execFile(executablePath, ["--version"], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : (/(\d+\.\d+\.\d+\.\d+)/.exec(String(stdout))?.[1] ?? null));
      });
    });
  }
  const hit = versionCache.get(executablePath);
  if (hit && hit.stamp === stamp) return hit.version;
  let version: string | null = null;
  try {
    version = newestVersionName(readdirSync(dirname(executablePath)));
  } catch {
    version = null;
  }
  versionCache.set(executablePath, { stamp, version });
  return version;
}

const warnedVersion = new Set<string>();

/**
 * Once per binary and process: a launch whose extension gives a user agent, and whose Chrome version could not be
 * read, starts with Chrome's own user agent. Not for a path (one with a separator) that does not exist: that launch fails ("Chromium exited
 * during launch") before any page loads. A bare command name not on PATH still warns before its spawn fails.
 */
function warnUnreadVersion(executablePath: string): void {
  if (warnedVersion.has(executablePath) || (/[\\/]/.test(executablePath) && !existsSync(executablePath))) return;
  warnedVersion.add(executablePath);
  process.emitWarning(`pilotfish: could not read the Chrome version of ${executablePath} before launch: it starts with its own user agent, so the script fetches of service and nested workers, and a service worker's update checks, carry the host's`, { code: "PILOTFISH_UA_VERSION" });
}

/** @internal Record the version a launched browser reported (a stale or wrong read is corrected for next time, on Windows). */
function noteLiveVersion(executablePath: string, version: string): void {
  const hit = versionCache.get(executablePath);
  if (hit) hit.version = version;
}

/** "en-IN" → "en-IN,en"; "en" → "en". */
export function acceptLanguage(locale: string): string {
  const base = locale.split("-")[0]!;
  return base && base !== locale ? `${locale},${base}` : locale;
}

export interface LaunchedProcess {
  process: ChildProcess;
  userDataDir: string;
  ownsUserDataDir: boolean;
  executablePath: string;
}

/**
 * A failed launch's temp profile, removed with retries (on Windows Chrome's helpers hold its files for a
 * moment after the main process exits), asynchronously: a synchronous retry loop (up to about 11 s) would
 * stall every other task in the process. One left behind is not worth masking the launch error.
 */
async function removeProfile(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}

/** No launch extension: the options as given; a proxy with credentials needs one (its local forwarder). */
function asGiven(opts: LaunchOptions): PreparedLaunch {
  if (opts.proxyServer && proxyHasCredentials(opts.proxyServer)) {
    throw new Error("A proxy with credentials needs a local forwarder, which only a launch extension provides (Chromium ignores credentials in --proxy-server)");
  }
  return { opts };
}

/** No launch extension: a headed browser on Linux needs a display. */
async function noDisplay(): Promise<LaunchDisplay> {
  throw new Error("Headed mode on Linux needs a display: set DISPLAY, run under xvfb-run, or use headless");
}

export async function launch(launchOpts: LaunchOptions = {}): Promise<Browser> {
  // A launch extension (extensions.ts) prepares what the host adds before Chrome starts; none: the options as given.
  const ext = launchOpts.extension === undefined ? launchExtension() : launchOpts.extension;
  const prepared = ext?.prepare ? await ext.prepare(launchOpts) : asGiven(launchOpts);
  let opts = prepared.opts;
  const executablePath = opts.executablePath ?? ext?.executablePath?.(opts) ?? findChromium();
  if (!executablePath) {
    await prepared.abort?.();
    throw (await prepared.failure?.()) ?? new Error(
      "No Chromium executable found. Set PILOTFISH_CHROME, pass executablePath, install Google Chrome, or run `npx playwright install chromium`.",
    );
  }
  // An extension's user agent as the browser's own, at the major of the binary about to start: the script fetches of
  // service and nested workers carry it.
  let uaMajor: string | null = null;
  const userAgentFor = opts.userAgent ? undefined : ext?.userAgent?.(opts);
  if (userAgentFor) {
    uaMajor = (await chromeVersionOf(executablePath))?.split(".")[0] ?? null;
    if (uaMajor) opts = { ...opts, userAgent: userAgentFor(uaMajor) };
    else warnUnreadVersion(executablePath);
  }
  const ownsUserDataDir = !opts.userDataDir;
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), "pilotfish-profile-"));
  const spawned = ext?.spawn?.(opts, userDataDir) ?? {};
  const args = defaultArgs(opts, userDataDir, spawned);
  // "Preload pages" off and no model manifest, before Chrome reads the profile (see profile-prefs.ts), with an
  // extension's own preferences. A caller's profile whose Preferences could not be read or written starts with
  // Chrome's preconnects on.
  if (!seedProfile(userDataDir, args, spawned.prefs)) {
    process.emitWarning(`pilotfish: could not set the launch prefs in ${userDataDir} (its Preferences is not valid JSON, or not writable): Chrome starts with "Preload pages" on, and may connect to a site directly before its first page is routed`, { code: "PILOTFISH_PROFILE_PREFS" });
  }
  // Headed on a Linux server with no screen: a display of the extension's (a virtual one), ended with the browser.
  let display: LaunchDisplay | null = null;
  if (opts.headless === false && process.platform === "linux" && !process.env["DISPLAY"]) {
    const { width, height } = opts.viewport ?? { width: 1280, height: 800 };
    try {
      display = await (ext?.startDisplay ?? noDisplay)({ width, height }, opts.screen);
    } catch (e) {
      await prepared.abort?.();
      if (ownsUserDataDir) await removeProfile(userDataDir);
      throw (await prepared.failure?.()) ?? e;
    }
  }

  let child: ChildProcess;
  try {
    child = spawn(executablePath, args, {
      // fd 3 is Chrome's CDP input, fd 4 its CDP output.
      stdio: ["ignore", opts.dumpio ? "inherit" : "ignore", opts.dumpio ? "inherit" : "pipe", "pipe", "pipe"],
      env: { ...process.env, ...(opts.timezoneId ? { TZ: opts.timezoneId } : {}), ...(display?.env ?? {}), ...(spawned.env ?? {}) },
      detached: process.platform !== "win32",
    });
  } catch (e) {
    // spawn() can throw at once (an argument it refuses; on Windows a .cmd, or a binary it cannot start):
    // nothing started, so the extension's own (a proxy forwarder), the display and the temp profile go here, as on a
    // failed launch below.
    await prepared.abort?.();
    display?.close();
    if (ownsUserDataDir) await removeProfile(userDataDir);
    throw (await prepared.failure?.()) ?? e;
  }

  const stderrChunks: string[] = [];
  if (!opts.dumpio) child.stderr?.on("data", (d: Buffer) => {
    if (stderrChunks.length < 200) stderrChunks.push(d.toString());
  });

  const transport = new PipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const connection = new Connection(transport, {
    ...opts.connection,
    onWire: opts.debugWire ? (dir, m) => process.stderr.write(`${dir === "send" ? "→" : "←"} ${m.slice(0, 400)}\n`) : opts.connection?.onWire,
  });

  const exitPromise = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(new Error(launchFailureMessage(executablePath, code, signal, stderrChunks.join(""))));
    });
    child.once("error", (err) => reject(new Error(`Failed to spawn Chromium at ${executablePath}: ${err.message}`)));
  });

  const launched: LaunchedProcess = { process: child, userDataDir, ownsUserDataDir, executablePath };
  const browser = new Browser(connection, launched, opts);
  prepared.attach?.(browser);
  if (display) browser.addCleanup(() => display.close());
  try {
    await Promise.race([
      browser._initialize(),
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Browser did not become ready within ${opts.launchTimeoutMs ?? 30_000}ms`)), opts.launchTimeoutMs ?? 30_000).unref(),
      ),
    ]);
  } catch (err) {
    // The CDP pipe usually closes a few ms before the process 'exit' event fires,
    // so the race above surfaces "pipe closed" and hides why Chrome died. Give the
    // process a moment to exit, then report its exit code and stderr.
    const exited = child.exitCode !== null || child.signalCode !== null
      ? true
      : await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 1_000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    // What the extension started (a local proxy forwarder) only closes via Browser.close(), which never runs on a
    // failed launch: close it here or its listening socket keeps the process alive after the error.
    await prepared.abort?.();
    display?.close();
    if (ownsUserDataDir) await removeProfile(userDataDir);
    const refused = await prepared.failure?.();
    if (refused) throw refused;
    if (exited) throw new Error(launchFailureMessage(executablePath, child.exitCode, child.signalCode, stderrChunks.join("")));
    throw err;
  }
  if (uaMajor) {
    // The version read before launch must be the one running, or the browser's own user agent names another
    // Chrome than its pages do. A wrong read (an update staged beside chrome.exe, say) is corrected for the
    // next launch; this one keeps going (only a worker's script fetches carry the other major).
    const live = /Chrome\/(\d+(?:\.\d+){1,3})/.exec((await browser.version().catch(() => null))?.product ?? "")?.[1];
    if (live && live.split(".")[0] !== uaMajor) {
      noteLiveVersion(executablePath, live);
      process.emitWarning(`pilotfish: ${executablePath} was read as Chrome ${uaMajor} before launch but runs ${live}; its own user agent named the wrong major this time`, { code: "PILOTFISH_UA_VERSION" });
    }
  }
  await prepared.ready?.(browser);
  return browser;
}

/** Human-readable launch failure with the most common server-side causes called out. */
export function launchFailureMessage(executablePath: string, code: number | null, signal: string | null, stderr: string): string {
  const hints: string[] = [];
  if (/No usable sandbox|setuid sandbox|namespace|zygote/i.test(stderr)) {
    hints.push(
      "Chromium's sandbox could not start. On Ubuntu 23.10+ (incl. GitHub ubuntu-24.04 runners) unprivileged user namespaces are blocked by AppArmor: " +
        "run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or install an AppArmor profile for Chrome. " +
        "Do not disable the sandbox for untrusted pages.",
    );
  }
  if (/PR_SET_NO_NEW_PRIVS/i.test(stderr) && /Failed to move to new namespace/i.test(stderr)) {
    hints.push(
      "If this runs under systemd, remove NoNewPrivileges=true from the unit: with no_new_privs set, AppArmor cannot apply the profile that grants Chrome user namespaces.",
    );
  }
  if (/error while loading shared libraries/i.test(stderr)) hints.push("Missing system libraries: run `npx playwright install-deps chromium` or use the provided Docker image.");
  if (/Missing X server|cannot open display/i.test(stderr)) hints.push("Headed mode needs a display: run under Xvfb (xvfb-run) or use headless.");
  return [
    `Chromium exited during launch (code=${code} signal=${signal}) — ${executablePath}`,
    ...hints.map((h) => `Hint: ${h}`),
    stderr ? `stderr:\n${stderr.trim().split("\n").slice(-25).join("\n")}` : "(no stderr output)",
  ].join("\n");
}

/** Attach to an already-running browser via its DevTools WebSocket URL. */
export async function connect(wsUrl: string, opts: Omit<LaunchOptions, "executablePath" | "userDataDir"> = {}): Promise<Browser> {
  const transport = await WebSocketTransport.connect(wsUrl);
  const connection = new Connection(transport, opts.connection);
  const browser = new Browser(connection, null, opts);
  await browser._initialize();
  return browser;
}
