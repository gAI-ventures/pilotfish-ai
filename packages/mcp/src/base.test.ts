// C1a (18 Nov): which delivered page a later change list is computed against, with the executor stubbed (no browser).
// The stub plays a page of 40 lines printed two ways, as the open MCP's executor prints them: browser_snapshot's
// three screens ("capture band") and an action's visible screen ("band 0", its first SCREEN lines). A reply that
// reaches the client whole becomes the base; a withheld, clipped, failed, whole_page or handed-off one never does; a
// change list is only ever against the same document, address and printing; and the evidence passes through as the
// executor wrote it.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TYPED_SECRET_MARK, type ActOptions, type ActOutcome } from "@pilotfish/agent";
import { applyInOrder } from "@pilotfish/perception";
import { configFromEnv } from "./config.js";
import { createMcpServer, type PilotfishMcp } from "./server.js";
import type { PageObstacle } from "./session.js";

const READ_VIEW = "capture band";
const SCREEN_VIEW = "band 0";
const SCREEN = 6;
const URL0 = "http://site.test/stays";

/** Evidence the stub's actions return: a value change, a removal and an added element that is not printed. */
const EVIDENCE = [
  "EVIDENCE:",
  '- value e3: "" → "North"',
  "- state: e4 checked: false → true",
  "- 1 element(s) removed: [e9]<button>Gadget</button>",
  "- 1 new interactive element(s): [e50]<button>Far below</button>",
  "- 2 request(s); network idle, DOM quiet",
].join("\n");

const textOf = (r: unknown) => ((r as CallToolResult).content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
const refsOf = (lines: string[]) => new Set(lines.flatMap((l) => [.../\[((?:f\d+)?e\d+)\]/.exec(l)?.slice(1, 2) ?? []]));
/** The lines after a change list's header line (`d.text`, as printed). */
const changeList = (reply: string) => {
  const at = reply.indexOf("CHANGES ONLY since");
  return at < 0 ? null : reply.slice(reply.indexOf("\n", at) + 1);
};

describe("C1a: the change-list base is the last page the client was given whole (stubbed executor)", () => {
  let pf: PilotfishMcp;
  let client: Client;
  let lines: string[];
  let url: string;
  let gen: number;
  let calls: { name: string; o: ActOptions }[];
  /** Per-test knobs. */
  let k: { readSecret: boolean; readClipped: boolean; readFails: boolean; noAlt: boolean; actSecret: boolean; obstacle: PageObstacle | null; screenCount: string[] | null; scroll: string | undefined; actClipped: boolean; actFails: boolean };
  /** What the next acting call does to the page before it is printed. */
  let mutate: ((name: string, input: Record<string, unknown>) => void) | null;

  const initial = () => [
    "<h1>Stays",
    '[e1]<button>Count',
    '[e2]<a href="/stays?page=2">Page 2',
    '[e3]<input label="Where" value="">',
    '[e4]<input type="checkbox" label="Free cancellation">',
    "[e9]<button>Gadget",
    ...Array.from({ length: 34 }, (_, i) => `Note ${i + 1}: free cancellation on most stays`),
  ];
  const doc = () => `t1:${gen}`;
  const readOutcome = (): ActOutcome => {
    if (k.readFails) return { ok: false, summary: "read_page failed", text: "Error: the page could not be read" };
    let body = lines.join("\n");
    if (k.readSecret) body += `\nEcho ${TYPED_SECRET_MARK}`;
    if (k.readClipped) body += "\n(output truncated at 24000 chars)";
    const text = `PAGE SNAPSHOT (${url} — "Stays"):\n${body}`;
    const read = { url, title: "Stays", tabs: "", note: "", body, liveRefs: refsOf(lines), truncated: k.readClipped, doc: doc(), view: READ_VIEW, ...(k.scroll !== undefined ? { scroll: k.scroll } : {}) };
    return { ok: true, summary: "read_page", text, read } as ActOutcome;
  };
  const actOutcome = (o: ActOptions): ActOutcome => {
    const screen = lines.slice(0, SCREEN);
    // k.screenCount: the screen's own above/below count lines as the serializer prints them ([] for none), else a plain note.
    const counts = k.screenCount ?? [`(${Math.max(0, lines.length - SCREEN)} lines below the viewport)`];
    const above = counts.filter((l) => l.includes(" above "));
    const below = counts.filter((l) => !l.includes(" above "));
    const body = [...above, ...screen].join("\n") + (k.actSecret ? `\nEcho ${TYPED_SECRET_MARK}` : "") + below.map((l) => `\n${l}`).join("") + (k.actClipped ? "\n(output truncated at 24000 chars)" : "");
    const head = `PAGE SNAPSHOT (${url} — "Stays"):\n`;
    const alt = (o as { alsoView?: string }).alsoView === READ_VIEW && !k.noAlt ? { alt: { view: READ_VIEW, body: lines.join("\n"), truncated: false } } : {};
    const page = { url, title: "Stays", tabs: "", note: "", body, liveRefs: refsOf(lines), truncated: k.actClipped, doc: doc(), view: SCREEN_VIEW, ...(k.scroll !== undefined ? { scroll: k.scroll } : {}), ...alt };
    return { ok: !k.actFails, summary: k.actFails ? "FAILED click: refused" : "click: changed", text: `${EVIDENCE}\n\n${head}${body}`, content: EVIDENCE, page } as ActOutcome;
  };

  /** The printing the MCP asked the executor for besides its own (ActOptions.alsoView), on the call `i` from the end. */
  const alsoOf = (i: number) => (calls.at(i)!.o as { alsoView?: string }).alsoView;
  const call = async (name: string, args: Record<string, unknown> = {}) => textOf(await client.callTool({ name, arguments: args }));
  const click = (ref = "e1") => call("browser_click", { ref });
  const snapshot = (args: Record<string, unknown> = {}) => call("browser_snapshot", args);
  const query = () => call("browser_query", { expression: "1" });

  beforeEach(async () => {
    await client?.close();
    await pf?.close();
    lines = initial();
    url = URL0;
    gen = 1;
    calls = [];
    k = { readSecret: false, readClipped: false, readFails: false, noAlt: false, actSecret: false, obstacle: null, screenCount: null, scroll: undefined, actClipped: false, actFails: false };
    mutate = null;
    pf = createMcpServer({ config: configFromEnv({}) });
    pf.session.act = async (name, input, o = {}) => {
      calls.push({ name, o });
      if (name === "read_page") return readOutcome();
      if (name === "query") return { ok: true, summary: "query: 1 chars", text: "1" };
      mutate?.(name, input);
      return actOutcome(o);
    };
    pf.session.page = (async () => ({ lastDocumentAt: gen, url })) as never;
    pf.session.obstacle = async () => {
      const o = k.obstacle;
      k.obstacle = null;
      return o;
    };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await pf.server.connect(serverSide);
    client = new Client({ name: "base", version: "1" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client?.close();
    await pf?.close();
  });

  const retitle = (t: string) => () => {
    lines[0] = `<h1>${t}`;
  };

  it("snapshot then action: a change list against the snapshot (not a full page), which rebuilds the page exactly", async () => {
    const snap = await snapshot();
    const snapBody = snap.slice(snap.indexOf("\n") + 1);
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(r).toMatch(/PAGE SNAPSHOT \([^)]*\): CHANGES ONLY since the page snapshot 1 browser result back/);
    // The executor was asked for the page as browser_snapshot prints it too.
    expect(calls.at(-1)!.o).toMatchObject({ alsoView: READ_VIEW });
    // Base truth: the change list applied to what the client was given is the page now, every line of it.
    expect(applyInOrder(snapBody, changeList(r)!)).toEqual(lines.map((l) => l.trim()));
    // Every ref of the page now is in the client's view (the snapshot plus this change list).
    const view = applyInOrder(snapBody, changeList(r)!).join("\n");
    for (const ref of refsOf(lines)) expect(view).toContain(`[${ref}]`);
  });

  it("the evidence passes through unchanged: old → new values, states, removals and an added element not printed", async () => {
    await snapshot();
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(r).toContain("CHANGES ONLY");
    expect(r.startsWith(EVIDENCE)).toBe(true);
  });

  it("an action reply after a snapshot that changes much of the page beyond the screen is the screen whole, never a longer change list", async () => {
    await snapshot();
    mutate = () => {
      for (let i = 10; i < 26; i++) lines[i] = `Note ${i}: price changed to ₹${i * 1000}`;
    };
    const r = await click();
    expect(r).not.toContain("CHANGES ONLY");
    expect(r).toContain('PAGE SNAPSHOT (http://site.test/stays — "Stays"):\n<h1>Stays');
  });

  it("a change list against the snapshot of half the action's screen or more is that screen whole, which is then the base", async () => {
    await snapshot();
    mutate = () => {
      lines[20] = "Note 15: price changed to ₹15,000 for two nights";
      lines[21] = "Note 16: price changed to ₹16,000 for two nights";
    };
    const r = await click();
    expect(r).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
    mutate = retitle("Stays (4)");
    expect(await click()).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
    expect(alsoOf(-1)).not.toBe(READ_VIEW);
  });

  it("a withheld snapshot never becomes the base: the next action prints the page whole", async () => {
    k.readSecret = true;
    const snap = await snapshot();
    expect(snap).toMatch(/^UNSAFE_OUTPUT/);
    k.readSecret = false;
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(r).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
    expect(alsoOf(-1)).toBeUndefined();
  });

  it("a withheld snapshot after a delivered page leaves no base and keeps the client unseen", async () => {
    await click(); // a full page, delivered: the base
    k.readSecret = true;
    expect(await snapshot()).toMatch(/^UNSAFE_OUTPUT/);
    k.readSecret = false;
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(calls.at(-1)!.o).toMatchObject({ unseen: true });
    expect(r).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
  });

  it("after a withheld action reply, a snapshot given whole is the base again (the page given whole again)", async () => {
    k.actSecret = true;
    expect(await click()).toMatch(/^UNSAFE_OUTPUT/);
    k.actSecret = false;
    await snapshot();
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(calls.at(-1)!.o).not.toHaveProperty("unseen");
    expect(r).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
  });

  it("a clipped snapshot (cut at the character cap) never becomes the base", async () => {
    await click(); // base: this screen
    k.readClipped = true;
    await snapshot();
    mutate = retitle("Stays (4)");
    const r = await click();
    // Against the screen two results back, never the clipped snapshot.
    expect(r).toMatch(/CHANGES ONLY since the page snapshot 2 browser results back/);
    expect(alsoOf(-1)).not.toBe(READ_VIEW);
  });

  it("a failed snapshot and a whole_page snapshot never become the base", async () => {
    await click();
    k.readFails = true;
    await snapshot();
    k.readFails = false;
    // whole_page: the executor gives no plain read (its printing is not one an action can repeat).
    const real = pf.session.act;
    pf.session.act = async (name, input, o) => (name === "read_page" ? { ok: true, summary: "read_page", text: `PAGE SNAPSHOT (${url}):\n${lines.join("\n")}` } : real(name, input, o));
    await snapshot({ whole_page: true });
    pf.session.act = real;
    mutate = retitle("Stays (4)");
    expect(await click()).toMatch(/CHANGES ONLY since the page snapshot 3 browser results back/);
  });

  it("a snapshot whose reply carried a person's hand-off note is not made the base", async () => {
    await click();
    k.obstacle = { category: "login", needs: "login_in_live_view", message: "Sign in to continue", url } as PageObstacle;
    const snap = await snapshot();
    expect(snap).toContain("NEEDS A PERSON");
    mutate = retitle("Stays (4)");
    expect(await click()).toMatch(/CHANGES ONLY since the page snapshot 2 browser results back/);
  });

  it("a new document on the same address after the snapshot: the page whole", async () => {
    await snapshot();
    gen = 2; // a reload
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(r).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
    // That whole screen is the base now: the next change is against it.
    mutate = retitle("Stays (5)");
    expect(await click()).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
  });

  it("a new address on the same document (pushState) after the snapshot: the page whole", async () => {
    await snapshot();
    mutate = () => {
      url = `${URL0}?page=2`;
    };
    expect(await click()).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
  });

  it("a snapshot more than SHOWN_KEEP results back is not used; at SHOWN_KEEP it still is", async () => {
    await snapshot();
    for (let i = 0; i < 7; i++) await query();
    mutate = retitle("Stays (4)");
    expect(await click()).toMatch(/CHANGES ONLY since the page snapshot 8 browser results back/);
    await snapshot();
    for (let i = 0; i < 8; i++) await query();
    mutate = retitle("Stays (5)");
    expect(await click()).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
  });

  it("an executor that cannot print the page the snapshot's way gets the page whole, never a diff across printings", async () => {
    await snapshot();
    k.noAlt = true;
    mutate = retitle("Stays (4)");
    expect(await click()).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
  });

  it("a batch after a snapshot: only its last step's page is shown, as a change list against the snapshot; no earlier step's page becomes a base", async () => {
    await snapshot();
    let n = 0;
    mutate = () => {
      n++;
      lines[0] = `<h1>Stays (${n})`;
    };
    const r = await call("browser_actions", { actions: [{ action: "click", ref: "e1" }, { action: "click", ref: "e1" }] });
    expect(calls.slice(-2).map((c) => c.o)).toEqual([expect.objectContaining({ alsoView: READ_VIEW }), expect.objectContaining({ alsoView: READ_VIEW })]);
    expect(r).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
    expect(changeList(r)).toContain("<h1>Stays (2)");
    expect(changeList(r)).not.toContain("Stays (1)");
    mutate = retitle("Stays (9)");
    // Still against the snapshot (a change list never moves the base).
    expect(await click()).toMatch(/CHANGES ONLY since the page snapshot 2 browser results back/);
  });

  // ---- C1a' (18 Nov): against a snapshot base, the reply says whose printing the change list is against and ends its
  // first line with the action's own visible-screen counts, from the same capture; a screen base is as before.
  const ABOVE = "(3 interactive elements above the viewport; scroll up to reveal)";
  const BELOW = "(27 interactive elements below the viewport; scroll down to reveal)";
  const FRAMING = " That base is browser_snapshot's printing (the viewport and a screen above and below); the visible screen's own above/below counts, if any, end this line.";
  const firstPageLine = (r: string) => r.slice(r.indexOf("PAGE SNAPSHOT (")).split("\n")[0]!;

  it("C1a': a change list against a snapshot base says so and ends its header line with the screen's own above/below counts", async () => {
    k.screenCount = [ABOVE, BELOW];
    const snap = await snapshot();
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(firstPageLine(r)).toBe(
      `PAGE SNAPSHOT (${URL0} — "Stays"): CHANGES ONLY since the page snapshot 1 browser result back. Lines not listed are as shown there and their refs still work; "~ " marks an unchanged line shown for context. (browser_snapshot gives the whole screen again.)${FRAMING} ${ABOVE} ${BELOW}`,
    );
    // The counts are on the header line only: the change list applied to the snapshot is still exactly the page now.
    expect(changeList(r)).not.toContain("interactive elements");
    expect(applyInOrder(snap.slice(snap.indexOf("\n") + 1), changeList(r)!)).toEqual(lines.map((l) => l.trim()));
  });

  it("C1a': 'the same as' a snapshot base carries the same framing and counts", async () => {
    k.screenCount = [BELOW];
    await snapshot();
    const r = await click();
    expect(firstPageLine(r)).toBe(`PAGE SNAPSHOT (${URL0} — "Stays"): the same as the page snapshot 1 browser result back; its refs still work.${FRAMING} ${BELOW}`);
  });

  it("C1a': nothing above or below the visible screen: the framing alone, with no count, as a whole screen prints none", async () => {
    k.screenCount = [];
    await snapshot();
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(firstPageLine(r).endsWith(`(browser_snapshot gives the whole screen again.)${FRAMING}`)).toBe(true);
    expect(r).not.toContain("interactive elements");
  });

  it("C1a': a change list against a screen base is byte for byte as before (no framing, no counts)", async () => {
    k.screenCount = [ABOVE, BELOW];
    await click(); // the whole screen: the base
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(r).toBe(
      `${EVIDENCE}\n\nPAGE SNAPSHOT (${URL0} — "Stays"): CHANGES ONLY since the page snapshot 1 browser result back. Lines not listed are as shown there and their refs still work; "~ " marks an unchanged line shown for context. (browser_snapshot gives the whole screen again.)\n~ ${ABOVE}\n<h1>Stays (4)\n(replaces 1 line(s))`,
    );
    expect(await click()).toBe(
      `${EVIDENCE}\n\nPAGE SNAPSHOT (${URL0} — "Stays"): CHANGES ONLY since the page snapshot 2 browser results back. Lines not listed are as shown there and their refs still work; "~ " marks an unchanged line shown for context. (browser_snapshot gives the whole screen again.)\n~ ${ABOVE}\n<h1>Stays (4)\n(replaces 1 line(s))`,
    );
  });

  // ---- C1a2 (18 Nov): which base a delivered snapshot leaves. A still-valid fresh screen base is kept, and the next
  // action is exactly the screen-base reply; otherwise the snapshot is the base (with the framing and counts).
  const SCREEN_DELTA = (back: number) =>
    `${EVIDENCE}\n\nPAGE SNAPSHOT (${URL0} — "Stays"): CHANGES ONLY since the page snapshot ${back} browser results back. Lines not listed are as shown there and their refs still work; "~ " marks an unchanged line shown for context. (browser_snapshot gives the whole screen again.)\n~ ${ABOVE}\n<h1>Stays (4)\n(replaces 1 line(s))`;
  const againstSnapshot = (r: string) => firstPageLine(r).startsWith(`PAGE SNAPSHOT (${URL0} — "Stays"): CHANGES ONLY since the page snapshot 1 browser result back.`) && firstPageLine(r).includes(FRAMING);

  it("C1a2: a fresh valid screen base is kept over a later snapshot: the next action is the screen-base reply, byte for byte", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    await click(); // the whole screen: the base
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(await click()).toBe(SCREEN_DELTA(2));
    expect(alsoOf(-1)).toBe(SCREEN_VIEW);
  });

  it("C1a2: at SHOWN_KEEP for the next result the screen base is kept; one result older and the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    await click();
    for (let i = 0; i < 6; i++) await query();
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(await click()).toBe(SCREEN_DELTA(8));
  });

  it("C1a2: a screen base that would be past SHOWN_KEEP at the next result: the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    await click();
    for (let i = 0; i < 7; i++) await query();
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(againstSnapshot(await click())).toBe(true);
  });

  it("C1a2: no base: the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(againstSnapshot(await click())).toBe(true);
  });

  it("C1a2: a withheld screen reply leaves no base: the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    k.actSecret = true;
    expect(await click()).toMatch(/^UNSAFE_OUTPUT/);
    k.actSecret = false;
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(againstSnapshot(await click())).toBe(true);
  });

  it("C1a2: a clipped screen base is not kept: the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    k.actClipped = true;
    await click();
    k.actClipped = false;
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(againstSnapshot(await click())).toBe(true);
  });

  it("C1a2: a screen base from an error reply is not kept: the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    k.actFails = true;
    await click();
    k.actFails = false;
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(againstSnapshot(await click())).toBe(true);
  });

  it("C1a2: another document since the screen base (a reload): the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    await click();
    gen = 2;
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(againstSnapshot(await click())).toBe(true);
  });

  it("C1a2: another address on the same document since the screen base (pushState): the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    await click();
    url = `${URL0}?page=2`;
    await snapshot();
    mutate = retitle("Stays (4)");
    const r = await click();
    expect(firstPageLine(r)).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back\./);
    expect(firstPageLine(r)).toContain(FRAMING);
  });

  it("C1a2: scrolled since the screen base: the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    k.scroll = "0,0";
    await click();
    k.scroll = "0,800";
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(againstSnapshot(await click())).toBe(true);
  });

  it("C1a2: a screen base with no scroll position known is not kept: the snapshot is the base", async () => {
    k.screenCount = [ABOVE, BELOW];
    await click();
    await snapshot();
    mutate = retitle("Stays (4)");
    expect(againstSnapshot(await click())).toBe(true);
  });

  it("nothing changed since the snapshot: 'the same as' the snapshot", async () => {
    await snapshot();
    expect(await click()).toMatch(/PAGE SNAPSHOT \([^)]*\): the same as the page snapshot 1 browser result back; its refs still work/);
  });
});
