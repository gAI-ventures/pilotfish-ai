import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chromeVersionOf, defaultArgs, findChromium, launch, launchFailureMessage, newestVersionName } from "./launcher.js";

describe("which Chrome", () => {
  // A Playwright cache with one Chrome for Testing build, as on a machine that once ran `playwright install`.
  const cache = mkdtempSync(join(tmpdir(), "pf-pw-cache-"));
  const cft = { linux: join(cache, "chromium-1234", "chrome-linux64", "chrome"), win32: join(cache, "chromium-1234", "chrome-win64", "chrome.exe") } as const;
  for (const p of Object.values(cft)) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "");
  }
  const env = { PLAYWRIGHT_BROWSERS_PATH: cache, LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  const only = (...paths: string[]) => (p: string) => paths.includes(p) || p === cache || Object.values(cft).includes(p as never);

  it("takes Google Chrome stable (what CI and the servers run) over a cached Chrome for Testing build", () => {
    expect(findChromium({ os: "linux", env, exists: only("/usr/bin/google-chrome") })).toBe("/usr/bin/google-chrome");
    expect(findChromium({ os: "win32", env, exists: only("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") })).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    // A per-user install on Windows counts too.
    const perUser = join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
    expect(findChromium({ os: "win32", env, exists: only(perUser) })).toBe(perUser);
  });

  it("falls back to the cached build only without Google Chrome, and to other Chromium browsers after it; PILOTFISH_CHROME wins", () => {
    expect(findChromium({ os: "linux", env, exists: only("/usr/bin/chromium") })).toBe(cft.linux);
    expect(findChromium({ os: "linux", env: {}, exists: only("/usr/bin/chromium") })).toBe("/usr/bin/chromium");
    expect(findChromium({ os: "linux", env: { ...env, PILOTFISH_CHROME: "/opt/patched/chrome" }, exists: only("/opt/patched/chrome", "/usr/bin/google-chrome") })).toBe("/opt/patched/chrome");
    // Set but missing: auto-detect as before.
    expect(findChromium({ os: "linux", env: { ...env, PILOTFISH_CHROME: "/nope" }, exists: only("/usr/bin/google-chrome") })).toBe("/usr/bin/google-chrome");
    expect(findChromium({ os: "linux", env: {}, exists: () => false })).toBeUndefined();
  });

  afterAll(() => rmSync(cache, { recursive: true, force: true }));
});

describe("Chrome's own traffic", () => {
  it("turns off the startup requests a page's host could carry, and points the model manifest at the profile's empty config", () => {
    const args = defaultArgs({}, "/tmp/p");
    const disabled = args.find((a) => a.startsWith("--disable-features="))!.slice("--disable-features=".length).split(",");
    expect(disabled).toEqual(expect.arrayContaining(["AimEnabled", "SafeBrowsingHashPrefixRealTimeLookups", "NetworkTimeServiceQuerying", "OptimizationHints"]));
    // One --disable-features: Chrome keeps only the last one.
    expect(args.filter((a) => a.startsWith("--disable-features="))).toHaveLength(1);
    expect(args).toContain(`--optimization-guide-manifest-override=${join("/tmp/p", "pilotfish-model-manifest.json")}`);
  });
});

describe("a headed window", () => {
  it("has no unsupported-flag bar over its page (--test-type), and a headless browser has no such flag", () => {
    expect(defaultArgs({ headless: false }, "/tmp/p")).toContain("--test-type");
    expect(defaultArgs({}, "/tmp/p")).not.toContain("--test-type");
  });
});

describe("proxy flags", () => {
  it("sends Chrome's own services around the proxy, plus any hosts asked for, and nothing without a proxy", () => {
    const bypass = (a: string[]) => a.find((x) => x.startsWith("--proxy-bypass-list="));
    const withProxy = bypass(defaultArgs({ proxyServer: "http://127.0.0.1:9000", proxyBypass: ["intranet.example"] }, "/tmp/p"));
    expect(withProxy).toMatch(/update\.googleapis\.com;\*\.gvt1\.com;.*safebrowsing\.googleapis\.com.*;intranet\.example$/);
    expect(bypass(defaultArgs({}, "/tmp/p"))).toBeUndefined();
  });
});

describe("headed flags", () => {
  it("lets headed Chrome on Linux render WebGL in software where no GPU answers (Xvfb), as headless does", () => {
    expect(defaultArgs({ headless: false }, "/tmp/p").includes("--enable-unsafe-swiftshader")).toBe(process.platform === "linux");
    expect(defaultArgs({ headless: true }, "/tmp/p")).not.toContain("--enable-unsafe-swiftshader");
    expect(defaultArgs({}, "/tmp/p")).not.toContain("--enable-unsafe-swiftshader");
  });
});

describe("Chrome version before launch", () => {
  it("picks the newest versioned folder or manifest beside chrome.exe", () => {
    expect(newestVersionName(["156.0.8078.74", "chrome.exe", "SetupMetrics", "155.0.7999.120"])).toBe("156.0.8078.74");
    expect(newestVersionName(["151.0.7922.34.manifest", "chrome.dll", "locales"])).toBe("151.0.7922.34");
    expect(newestVersionName(["156.0.8078.9", "156.0.8078.74"])).toBe("156.0.8078.74"); // numeric, not text, order
    expect(newestVersionName(["chrome.exe"])).toBeNull();
  });

  it("reads a binary's version without starting a browser, and reads it again once the file changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-ver-"));
    try {
      if (process.platform === "win32") {
        const exe = join(dir, "chrome.exe");
        writeFileSync(exe, "x");
        mkdirSync(join(dir, "150.0.7001.2"));
        expect(await chromeVersionOf(exe)).toBe("150.0.7001.2");
        mkdirSync(join(dir, "151.0.7303.4"));
        writeFileSync(exe, "xy"); // an update rewrites chrome.exe
        expect(await chromeVersionOf(exe)).toBe("151.0.7303.4");
      } else {
        const exe = join(dir, "chrome");
        writeFileSync(exe, `#!/bin/sh\necho "Google Chrome 150.0.7001.2 "\n`, { mode: 0o755 });
        expect(await chromeVersionOf(exe)).toBe("150.0.7001.2");
        writeFileSync(exe, `#!/bin/sh\necho "Google Chrome 151.0.7303.4"\n#\n`, { mode: 0o755 });
        expect(await chromeVersionOf(exe)).toBe("151.0.7303.4");
      }
      expect(await chromeVersionOf(join(dir, "missing"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A deployment may launch a wrapper script that execs google-chrome-stable: upgrading Chrome leaves the wrapper's
  // file as it was, and the version read must still be the new one.
  it.skipIf(process.platform === "win32")("reads the Chrome a wrapper script starts again after that Chrome is upgraded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-ver-wrap-"));
    try {
      const real = join(dir, "google-chrome-stable");
      const wrapper = join(dir, "pilotfish-chrome");
      writeFileSync(real, `#!/bin/sh\necho "Google Chrome 156.0.8078.47"\n`, { mode: 0o755 });
      writeFileSync(wrapper, `#!/bin/sh\nexec "${real}" "$@"\n`, { mode: 0o755 });
      expect(await chromeVersionOf(wrapper)).toBe("156.0.8078.47");
      writeFileSync(real, `#!/bin/sh\necho "Google Chrome 157.0.8100.12"\n`, { mode: 0o755 });
      expect(await chromeVersionOf(wrapper)).toBe("157.0.8100.12");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launch failure diagnostics", () => {
  it("explains sandbox failures with the AppArmor fix", () => {
    const m = launchFailureMessage("/usr/bin/chrome", 1, null, "FATAL:zygote_host_impl_linux.cc No usable sandbox!");
    expect(m).toMatch(/apparmor_restrict_unprivileged_userns=0/);
    expect(m).toMatch(/No usable sandbox/);
  });

  it("points at systemd NoNewPrivileges when the namespace move is refused", () => {
    const m = launchFailureMessage("/usr/bin/google-chrome-stable", null, "SIGABRT", "A parent process set prctl(PR_SET_NO_NEW_PRIVS, ...)\nFailed to move to new namespace: errno = Operation not permitted\nZygote process exited prematurely");
    expect(m).toMatch(/NoNewPrivileges/);
  });

  it("reports the process exit and stderr instead of 'pipe closed' when the browser dies at startup", async () => {
    // A fake "browser" that writes to stderr and exits immediately.
    const err = await launch({ executablePath: "/bin/sh", args: [] , launchTimeoutMs: 5_000 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited during launch/);
    expect((err as Error).message).not.toMatch(/pipe closed/);
  });

  it("leaves no temp profile behind when spawn() itself throws", async () => {
    // A NUL in the path: spawn() throws at once (ERR_INVALID_ARG_VALUE) on every platform, before any process.
    const dir = mkdtempSync(join(tmpdir(), "pf-spawn-"));
    const keys = ["TMPDIR", "TEMP", "TMP"] as const;
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) process.env[k] = dir;
    try {
      const err = await launch({ executablePath: "chrome\0bad" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(readdirSync(dir), "temp profiles left in the temp dir").toEqual([]);
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with no launch extension, refuses a proxy with credentials (Chromium would ignore them): only an extension forwards one", async () => {
    const err = await launch({ proxyServer: "http://user:pass@127.0.0.1:9", executablePath: "/nonexistent/chrome", extension: null }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/proxy with credentials needs a local forwarder/);
  });
});
