import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_MANIFEST_OVERRIDE, profileDirectory, seedProfile } from "./profile-prefs.js";

describe("profile prefs", () => {
  const dirs: string[] = [];
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "pf-prefs-"));
    dirs.push(d);
    return d;
  };
  const prefs = (d: string, profile = "Default") => JSON.parse(readFileSync(join(d, profile, "Preferences"), "utf8")) as Record<string, any>;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("turns 'Preload pages' off in a new profile and writes the empty model-manifest config", () => {
    const d = fresh();
    expect(seedProfile(d)).toBe(true);
    expect(prefs(d)).toEqual({ net: { network_prediction_options: 2 } });
    expect(JSON.parse(readFileSync(join(d, MODEL_MANIFEST_OVERRIDE), "utf8"))).toEqual({});
  });

  it("merges into a kept profile's Preferences, keeping everything else", () => {
    const d = fresh();
    mkdirSync(join(d, "Default"));
    writeFileSync(join(d, "Default", "Preferences"), JSON.stringify({ net: { network_prediction_options: 0, other: 1 }, profile: { name: "kept" }, list: [1, 2] }));
    expect(seedProfile(d)).toBe(true);
    expect(prefs(d)).toEqual({ net: { network_prediction_options: 2, other: 1 }, profile: { name: "kept" }, list: [1, 2] });
  });

  it("follows --profile-directory, and leaves a Preferences file it cannot read alone", () => {
    const d = fresh();
    expect(profileDirectory(["--profile-directory=Profile 2"])).toBe("Profile 2");
    expect(seedProfile(d, ["--profile-directory=Profile 2"])).toBe(true);
    expect(prefs(d, "Profile 2").net.network_prediction_options).toBe(2);
    expect(existsSync(join(d, "Default", "Preferences"))).toBe(false);
    const broken = fresh();
    mkdirSync(join(broken, "Default"));
    writeFileSync(join(broken, "Default", "Preferences"), "{not json");
    expect(seedProfile(broken)).toBe(false);
    expect(readFileSync(join(broken, "Default", "Preferences"), "utf8")).toBe("{not json");
  });

  it("writes into the profile Local State used last when no switch names one, and never outside the user data dir", () => {
    const d = fresh();
    writeFileSync(join(d, "Local State"), JSON.stringify({ profile: { last_used: "Profile 3" } }));
    expect(profileDirectory([], d)).toBe("Profile 3");
    expect(profileDirectory(["--profile-directory=Profile 2"], d)).toBe("Profile 2");
    expect(seedProfile(d)).toBe(true);
    expect(prefs(d, "Profile 3").net.network_prediction_options).toBe(2);
    expect(existsSync(join(d, "Default", "Preferences"))).toBe(false);
    // "System Profile" too: Chrome opens Default for it.
    for (const bad of ["../elsewhere", "..", "a/b", "a\\b", "", "System Profile"]) {
      writeFileSync(join(d, "Local State"), JSON.stringify({ profile: { last_used: bad } }));
      expect(profileDirectory([], d), JSON.stringify(bad)).toBe("Default");
    }
    writeFileSync(join(d, "Local State"), "{not json");
    expect(profileDirectory([], d)).toBe("Default");
  });
});
