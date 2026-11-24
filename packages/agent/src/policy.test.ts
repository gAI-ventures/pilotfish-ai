import { describe, it, expect, vi } from "vitest";
import { approvedByWords, asksForWrite, asksToPay, DefaultPolicy, holdsBack, isPrivateHost, isReloadKey, isSubmitKey, payApprovedByWords, spendCapIn } from "./policy.js";
import type { ActionContext, DefaultPolicyOptions, PolicyDecision, PreApproval, WriteKind } from "./policy.js";

describe("isPrivateHost", () => {
  it("flags loopback, RFC1918, link-local and CGNAT", () => {
    for (const h of ["localhost", "app.localhost", "x.local", "svc.internal", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it("flags IPv6 loopback, link-local, unique-local and IPv4-mapped loopback", () => {
    for (const h of ["::1", "[::1]", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "[::ffff:169.254.169.254]"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it("uses the shared classifier for literals: reserved ranges, site-local, translated, NAT64 and 6to4 forms", () => {
    for (const h of ["192.0.0.8", "198.18.0.1", "240.0.0.1", "224.0.0.1", "fec0::1", "::ffff:0:7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:7f00:1::", "[2002:a9fe:a9fe::1]"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["2002:808:808::1", "64:ff9b::808:808", "2606:4700::1"]) expect(isPrivateHost(h), h).toBe(false);
  });

  it("treats a trailing dot the same (localhost. is still loopback)", () => {
    expect(isPrivateHost("localhost.")).toBe(true);
    expect(isPrivateHost("127.0.0.1.")).toBe(true);
  });

  it("does NOT flag public hostnames that merely start with fc/fd/fe (the old bug)", () => {
    for (const h of ["fcc.gov", "fda.gov", "fdic.gov", "fedex.com", "fc-barcelona.com", "feedly.com", "example.com", "203.0.113.1", "::ffff:8.8.8.8"]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });

  it("flags IPv4-mapped IPv6 in hex-group form (how the URL parser serialises it)", () => {
    // WHATWG serialises [::ffff:169.254.169.254] as [::ffff:a9fe:a9fe]; [::ffff:127.0.0.1] as [::ffff:7f00:1].
    for (const h of ["::ffff:a9fe:a9fe", "[::ffff:a9fe:a9fe]", "::ffff:7f00:0001", "::a9fe:a9fe", "64:ff9b::a9fe:a9fe"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["::ffff:c000:020b", "::ffff:08080808"]) {
      // 192.0.2.11 (a documentation address, public to the classifier) and a single-group form that is not a mapped
      // quad stay public.
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
});

describe("isReloadKey", () => {
  it("matches every reload shortcut", () => {
    for (const k of ["Control+r", "Control+R", "ctrl+r", "Meta+r", "Cmd+R", "Control+Shift+r", "Meta+Shift+R", "F5", "Control+F5", "Shift+F5", "BrowserRefresh", "Control+KeyR"]) {
      expect(isReloadKey(k), k).toBe(true);
    }
  });
  it("does not match typing r, other shortcuts or other keys", () => {
    for (const k of ["r", "R", "Shift+r", "Alt+r", "Control+t", "Control+a", "Enter", "F4", "F6", "Escape", "Control"]) {
      expect(isReloadKey(k), k).toBe(false);
    }
  });
});

describe("isSubmitKey", () => {
  it("matches Enter in every spelling, alone or with a modifier", () => {
    for (const k of ["Enter", "Return", "NumpadEnter", "\r", "\n", "Space", " ", "Control+Enter", "Meta+Enter", "Cmd+Return", "ctrl+shift+Enter"]) {
      expect(isSubmitKey(k), k).toBe(true);
    }
  });
  it("does not match other keys or modifier-only chords", () => {
    for (const k of ["a", "Tab", "Escape", "ArrowDown", "Control", "Control+a", "Shift+Tab"]) {
      expect(isSubmitKey(k), k).toBe(false);
    }
  });
});

describe("DefaultPolicy navigation", () => {
  const nav = (url: string, opts = {}) => new DefaultPolicy(opts).check({ tool: "navigate", input: { url }, url: "about:blank", task: "t" });

  it("denies private/loopback targets and allows public ones", async () => {
    expect((await nav("http://169.254.169.254/latest/meta-data/")).kind).toBe("deny");
    expect((await nav("http://127.0.0.1:7700/")).kind).toBe("deny");
    expect((await nav("https://fcc.gov/filings")).kind).toBe("allow");
  });

  it("allows private targets when allowPrivateNetwork is set (dev)", async () => {
    expect((await nav("http://127.0.0.1:3000/", { allowPrivateNetwork: true })).kind).toBe("allow");
  });

  it("rejects non-http(s) schemes", async () => {
    expect((await nav("file:///etc/passwd")).kind).toBe("deny");
  });

  it("refuses a private host even when the allowlist names it, unless allowPrivateNetwork is set", async () => {
    // The private-network check runs before the allowlist, so listing "127.0.0.1" does not unlock it.
    expect((await nav("http://127.0.0.1:7700/admin", { allowedHosts: ["127.0.0.1"] })).kind).toBe("deny");
    expect((await nav("http://127.0.0.1:7700/admin", { allowedHosts: ["127.0.0.1"], allowPrivateNetwork: true })).kind).toBe("allow");
  });

  it("refuses a public host outside the allowlist, and takes a wildcard glob for its subdomains", async () => {
    expect((await nav("https://evil.example.net/", { allowedHosts: ["*.example.com"] })).kind).toBe("deny");
    expect((await nav("https://shop.example.com/", { allowedHosts: ["*.example.com"] })).kind).toBe("allow");
  });
});

/**
 * The rules CLAUDE.md states for irreversible steps and the pre-approvals that cover them. These drive
 * the real DefaultPolicy.check, so a change to any of them has to be a deliberate one.
 */
const IRREVERSIBLE: Array<[WriteKind, string]> = [
  ["pay", "Place order"],
  ["delete", "Delete"],
  ["send", "Send message"],
  ["transfer", "Transfer funds"],
  ["cancel", "Cancel subscription"],
];

/** The checkout shape CLAUDE.md uses as its example: a task that pre-approved $200 of payment in USD. */
const PAY_UP_TO_200: PreApproval = { kinds: ["pay"], maxAmount: 200, currency: "USD" };

/** The shape agent.ts passes for a ref click: the verdict is judged on the target's own text. */
function clickOn(target: string, opts: DefaultPolicyOptions = {}, extra: Partial<ActionContext> = {}): Promise<PolicyDecision> | PolicyDecision {
  return new DefaultPolicy(opts).check({ tool: "click", input: { ref: "e1" }, url: "https://shop.example.com/cart", target: `<button>${target}</button>`, task: "buy a gift card", ...extra });
}

/** Narrow the union so a test can read `write` / `reason` without casts. */
function confirm(d: PolicyDecision): Extract<PolicyDecision, { kind: "confirm" }> {
  expect(d.kind, JSON.stringify(d)).toBe("confirm");
  return d as Extract<PolicyDecision, { kind: "confirm" }>;
}

function allow(d: PolicyDecision): Extract<PolicyDecision, { kind: "allow" }> {
  expect(d.kind, JSON.stringify(d)).toBe("allow");
  return d as Extract<PolicyDecision, { kind: "allow" }>;
}

describe("DefaultPolicy: a page's own tools (WebMCP page_tool)", () => {
  const tool = (target: string, input: Record<string, unknown> = {}, opts: DefaultPolicyOptions = {}) =>
    new DefaultPolicy(opts).check({ tool: "page_tool", input: { tool: "t", ...input }, url: "https://hotel.example.com/", target: `<page-tool name="t">${target}</page-tool>`, task: "find a room" });

  it("judges a tool by its name in words, like a control", async () => {
    expect((await tool("search rooms")).kind).toBe("allow");
    expect(await tool("place order")).toMatchObject({ kind: "confirm", write: "pay" });
    expect(await tool("delete booking")).toMatchObject({ kind: "confirm", write: "delete" });
    expect(await tool("send message")).toMatchObject({ kind: "confirm", write: "send" });
    // A filter is not a payment, and taking an item out of a cart is not a deletion.
    expect((await tool("filter by pay")).kind).toBe("allow");
    expect((await tool("remove item from cart")).kind).toBe("allow");
  });

  it("asks about a tool the page marks consequential, with the kind its words name, so a pre-approval covers it", async () => {
    const consequential = { consequential: true };
    expect(await tool("book room - Books the room for the dates", consequential)).toMatchObject({ kind: "confirm", write: "pay" });
    // No word names the kind: asked all the same, as the page says it has consequences.
    const plain = await tool("update profile - Saves your profile", consequential);
    expect(plain.kind).toBe("confirm");
    expect((plain as { write?: string }).write).toBeUndefined();
    expect((await tool("book room - Books the room", consequential, { preApproved: { kinds: ["pay"] } })).kind).toBe("allow");
    expect((await tool("book room - Books the room for $120", consequential, { preApproved: { kinds: ["pay"], maxAmount: 100, currency: "USD" } })).kind).toBe("confirm");
  });

  it("lets a form tool that only fills its form through (its submit button is judged when clicked), and stops at a trial's commit", async () => {
    expect((await tool("place order", { fillsOnly: true })).kind).toBe("allow");
    expect((await tool("book room", { consequential: true }, { trial: true })).kind).toBe("deny");
    expect((await tool("confirm booking", {}, { trial: true })).kind).toBe("deny");
    expect((await tool("search rooms", {}, { trial: true })).kind).toBe("allow");
  });

  it("keeps the allowed hosts", async () => {
    expect((await tool("search rooms", {}, { allowedHosts: ["other.example"] })).kind).toBe("deny");
  });
});

describe("DefaultPolicy irreversible actions", () => {
  it("asks the person before each irreversible kind, and names the kind on the verdict", async () => {
    for (const [kind, label] of IRREVERSIBLE) {
      const d = confirm(await clickOn(label));
      expect(d.write, label).toBe(kind);
      expect(d.reason, label).toContain("Target looks irreversible");
    }
  });

  it("a pre-approval for that kind turns the ask into an allow, with a note saying so", async () => {
    for (const [kind, label] of IRREVERSIBLE) {
      const d = allow(await clickOn(label, { preApproved: { kinds: [kind] } }));
      expect(d.note, label).toBe(`pre-approved ${kind}`);
    }
  });

  it("asks about the same steps in other languages, and lets a menu word or a filter's removal through (review, 3 Nov)", async () => {
    const asks: Array<[string, string]> = [
      ["pay", "Jetzt kaufen"], ["pay", "Zahlungspflichtig bestellen"], ["pay", "Pagar"], ["pay", "Finalizar compra"], ["pay", "Passer la commande"],
      ["pay", "Conferma ordine"], ["pay", "Zapłać"], ["pay", "Satın al"], ["pay", "立即购买"], ["pay", "注文を確定する"], ["pay", "भुगतान करें"], ["pay", "결제하기"],
      ["delete", "Löschen"], ["delete", "Supprimer"], ["delete", "削除"], ["send", "Enviar"], ["send", "发送"], ["transfer", "Überweisen"], ["transfer", "转账"],
      ["cancel", "Kündigen"], ["cancel", "Résilier"], ["cancel", "解約"],
    ];
    for (const [kind, label] of asks) expect(confirm(await clickOn(label)).write, label).toBe(kind);
    for (const label of ["Comprar", "Pagamento", "Filter löschen", "Eliminar filtros", "Supprimer les filtres", "Pagina siguiente"]) expect((await clickOn(label)).kind, label).toBe("allow");
  });

  it("a pre-approval for another kind does not cover it", async () => {
    const d = confirm(await clickOn("Place order", { preApproved: { kinds: ["send"] } }));
    expect(d.write).toBe("pay");
  });

  it("checks a submitting type and an Enter press, but not a plain type or another key", async () => {
    // agent.ts sets `submit` on the input for a type that submits; a newline in the text alone is not one.
    const typing = (input: Record<string, unknown>): ActionContext => ({ tool: "type", input, url: "https://shop.example.com/cart", target: "Send message", task: "t" });
    expect((await new DefaultPolicy().check(typing({ ref: "e1", submit: true }))).kind).toBe("confirm");
    expect((await new DefaultPolicy().check(typing({ ref: "e1" }))).kind).toBe("allow");
    const pressing = (key: string): ActionContext => ({ tool: "press", input: { key }, url: "https://shop.example.com/cart", target: "Send message", task: "t" });
    expect((await new DefaultPolicy().check(pressing("Enter"))).kind).toBe("confirm");
    expect((await new DefaultPolicy().check(pressing("Escape"))).kind).toBe("allow");
  });

  it("lets a disclosure control, and a filter whose label reads like a step it is not, through", async () => {
    // aria-haspopup is structural: the control opens a menu, and the click that commits is on what it
    // opens — a different target, judged on its own (agent.ts re-checks the chosen option as a click).
    expect((await clickOn("Pay", {}, { target: '<button aria-haspopup="true">Pay</button>' })).kind).toBe("allow");
    expect((await clickOn("Share", {}, { target: '<button aria-haspopup="menu">Share</button>' })).kind).toBe("allow");
    expect((await clickOn("Delete account", {}, { target: '<button aria-haspopup="menu">Delete account</button>' })).kind).toBe("allow");
    // "Pay" on a job board is the salary filter; a chip takes a filter off rather than deleting anything.
    expect((await clickOn("Pay", {}, { target: '[e12]<button type="button" id="salaryType_filter_button">Pay</button>' })).kind).toBe("allow");
    expect((await clickOn("Remove filter", {}, { target: '<button data-testid="remove_chip">Remove filter</button>' })).kind).toBe("allow");
    expect((await clickOn("Remove all filters", {}, { target: '<button class="facet-clear">Remove all filters</button>' })).kind).toBe("allow");
  });

  it("lets \"purchase\" naming a facet or a record through (Steam's Purchase Type filter, 3 Nov), never the step itself, a step's wording or an amount", async () => {
    for (const label of ["Purchase Type", "Purchase type", "Purchase History", "Purchase date", "Purchase options", "View purchase details"]) {
      expect((await clickOn(label, {}, { target: `[e505]<button type="button" role="button">${label}</button>` })).kind, label).toBe("allow");
    }
    for (const label of ["Purchase", "Purchase now", "Purchase ticket", "Complete purchase details", "Confirm purchase", "Purchase type: Pay now", "Purchase options from $45.00", "Purchase history and pay"]) {
      expect(confirm(await clickOn(label, {}, { target: `<button type="button">${label}</button>` })).write, label).toBe("pay");
    }
  });

  it("does not let an attribute that merely contains a filter-ish word excuse a destructive label", async () => {
    // The carve-out reads the target's wording, never its id or class: "toggle", "menu", "chip" and
    // "dropdown" say nothing about what a control does, so a genuinely destructive button carrying one
    // is still confirmed — and still judged against the pre-approval's amount limit.
    for (const attr of ['id="delete_toggle"', 'class="dropdown-item danger"', 'data-testid="remove_chip"', 'aria-controls="filter-panel"']) {
      expect(confirm(await clickOn("Delete account", {}, { target: `<button ${attr}>Delete account</button>` })).write, attr).toBe("delete");
    }
    // An amount is never excused by a filter word either: this one is judged against the limit.
    expect(confirm(await clickOn("Pay $900.00", { preApproved: PAY_UP_TO_200 }, { target: '<button class="sort-asc">Pay $900.00</button>' })).reason).toContain("is over the pre-approved 200 USD");
    // And a payment that merely sits under a filter-ish class is still a payment.
    expect(confirm(await clickOn("Pay now", { preApproved: PAY_UP_TO_200 }, { target: '<button class="dropdown-item">Pay now</button>' })).write).toBe("pay");
  });

  it("reads a filter word out of a URL, a test id or a contradicting label as no evidence at all", async () => {
    // A query string says where a link goes, not what clicking it does: a checkout URL carrying a sort
    // parameter is a checkout, and the pre-approval's amount limit still has to hold.
    const checkout = '<a href="/checkout?sort=price">Pay now</a>';
    expect(confirm(await clickOn("Pay now", { preApproved: PAY_UP_TO_200 }, { target: checkout })).write).toBe("pay");
    // The same, when the markup names the control in code as well as the URL.
    expect(confirm(await clickOn("Pay now", { preApproved: PAY_UP_TO_200 }, { target: '<button id="pay_now_sortable">Pay now</button>' })).write).toBe("pay");
    // A label that contradicts the visible text is not evidence of anything: this is a deletion, and its
    // aria-label is a filter phrase, so the wording (not the label alone) is what decides.
    expect(confirm(await clickOn("Delete account", {}, { target: '<button aria-label="Clear all filters">Delete account</button>' })).write).toBe("delete");
    // The carve-out still holds where the evidence is the control's own: its wording, or the way the
    // page names it in code. These are filters, not steps.
    expect((await clickOn("Pay", {}, { target: '<a href="/jobs?sort=salary" id="salaryType_filter_button">Pay</a>' })).kind).toBe("allow");
    expect((await clickOn("Remove filter", {}, { target: '<button aria-label="Remove filter">Remove filter</button>' })).kind).toBe("allow");
    // A bare "Pay" whose only filter-ish word is in a URL is asked about rather than assumed harmless:
    // the safe direction, and the pre-approval's amount limit still gets its look.
    expect(confirm(await clickOn("Pay", { preApproved: PAY_UP_TO_200 }, { target: '<a href="/jobs?sort=salary">Pay</a>' })).write).toBe("pay");
  });

  it("custom irreversiblePatterns carry no kind, so no pre-approval can cover them", async () => {
    const opts: DefaultPolicyOptions = { irreversiblePatterns: [/\bconfirm booking\b/i], preApproved: { kinds: ["pay"] } };
    const d = confirm(await clickOn("Confirm booking", opts));
    expect(d.write).toBeUndefined();
  });
});

describe("DefaultPolicy pre-approved amount limits", () => {
  it("allows a payment under the limit and asks about one over it", async () => {
    expect(allow(await clickOn("Pay $45.00", { preApproved: PAY_UP_TO_200 })).note).toContain("pre-approved pay: $45.00 within 200 USD");
    expect(confirm(await clickOn("Pay $245.00", { preApproved: PAY_UP_TO_200 })).reason).toContain("is over the pre-approved 200 USD");
  });

  it("treats the limit as inclusive: an amount equal to it passes, one cent over does not", async () => {
    expect((await clickOn("Pay $200.00", { preApproved: PAY_UP_TO_200 })).kind).toBe("allow");
    expect((await clickOn("Pay $200.01", { preApproved: PAY_UP_TO_200 })).kind).toBe("confirm");
  });

  it("reads the largest amount in the target, so a second, bigger number still trips the limit", async () => {
    expect((await clickOn("Pay $45.00 (was $250.00)", { preApproved: PAY_UP_TO_200 })).kind).toBe("confirm");
  });

  it("bounds transfer too, and leaves the kinds that take no amount unbounded", async () => {
    expect((await clickOn("Transfer funds $500.00", { preApproved: { kinds: ["transfer"], maxAmount: 200, currency: "USD" } })).kind).toBe("confirm");
    expect((await clickOn("Send message $500.00", { preApproved: { kinds: ["send"], maxAmount: 200 } })).kind).toBe("allow");
  });

  it("a pay pre-approval with no limit allows any amount", async () => {
    expect((await clickOn("Pay $99,999.00", { preApproved: { kinds: ["pay"] } })).kind).toBe("allow");
  });
});

describe("DefaultPolicy pre-approved currency", () => {
  it("asks when the action's amount is in another currency", async () => {
    expect(confirm(await clickOn("Pay ₹1,500.00", { preApproved: PAY_UP_TO_200 })).reason).toContain("is not in USD");
  });

  it("compares currency case-insensitively", async () => {
    expect((await clickOn("Pay $45.00", { preApproved: { kinds: ["pay"], maxAmount: 200, currency: "usd" } })).kind).toBe("allow");
  });

  it("reads a trailing ISO code as the currency", async () => {
    expect((await clickOn("Pay 45 EUR", { preApproved: { kinds: ["pay"], maxAmount: 200, currency: "EUR" } })).kind).toBe("allow");
    expect((await clickOn("Pay 45 EUR", { preApproved: PAY_UP_TO_200 })).kind).toBe("confirm");
  });

  it("passes an amount that names no currency at all", async () => {
    // The gate is `pre.currency && m.currency && m.currency !== pre.currency`: with no currency on the
    // amount there is nothing to compare against, so a USD-limited approval covers an unlabelled total.
    const d = await clickOn("Place order", { preApproved: PAY_UP_TO_200 }, { pageTotal: async () => ({ value: 45, text: "45.00" }) });
    expect(d.kind).toBe("allow");
  });
});

describe("DefaultPolicy pre-approved hosts", () => {
  it("holds on a matching host glob and not on another", async () => {
    const preApproved: PreApproval = { kinds: ["send"], hosts: ["*.example.com"] };
    expect((await clickOn("Send message", { preApproved }, { url: "https://mail.example.com/compose" })).kind).toBe("allow");
    // The wildcard covers the bare domain as well as its subdomains.
    expect((await clickOn("Send message", { preApproved }, { url: "https://example.com/compose" })).kind).toBe("allow");
    expect(confirm(await clickOn("Send message", { preApproved }, { url: "https://evil.example.net/compose" })).reason).toContain("the pre-approval does not cover evil.example.net");
  });

  it("an exact glob does not cover a subdomain", async () => {
    const preApproved: PreApproval = { kinds: ["send"], hosts: ["example.com"] };
    expect((await clickOn("Send message", { preApproved }, { url: "https://mail.example.com/compose" })).kind).toBe("confirm");
  });

  it("an empty hosts list reads as no restriction at all", async () => {
    const preApproved: PreApproval = { kinds: ["send"], hosts: [] };
    expect((await clickOn("Send message", { preApproved }, { url: "https://evil.example.net/compose" })).kind).toBe("allow");
  });

  it("cannot hold before a page is loaded, when the host is unknown", async () => {
    const preApproved: PreApproval = { kinds: ["send"], hosts: ["*.example.com"] };
    expect(confirm(await clickOn("Send message", { preApproved }, { url: "about:blank" })).reason).toContain("does not cover this page");
  });
});

describe("DefaultPolicy pre-approved limit without an amount", () => {
  it("asks when the target names no amount and the page offers no total", async () => {
    expect(confirm(await clickOn("Place order", { preApproved: PAY_UP_TO_200 })).reason).toContain("the amount could not be read to check the pre-approved limit");
  });

  it("asks when the page total reads as null, or when reading it throws", async () => {
    expect((await clickOn("Place order", { preApproved: PAY_UP_TO_200 }, { pageTotal: async () => null })).kind).toBe("confirm");
    const throws = async (): Promise<never> => {
      throw new Error("no page");
    };
    expect((await clickOn("Place order", { preApproved: PAY_UP_TO_200 }, { pageTotal: throws })).kind).toBe("confirm");
  });

  it("judges the page total when the target names none, and prefers the target's own amount", async () => {
    const total = { value: 45, currency: "USD", text: "$45.00" };
    expect((await clickOn("Place order", { preApproved: PAY_UP_TO_200 }, { pageTotal: async () => total })).kind).toBe("allow");
    expect((await clickOn("Place order", { preApproved: PAY_UP_TO_200 }, { pageTotal: async () => ({ value: 245, currency: "USD", text: "$245.00" }) })).kind).toBe("confirm");
    const pageTotal = vi.fn(async () => total);
    await clickOn("Pay $45.00", { preApproved: PAY_UP_TO_200 }, { pageTotal });
    expect(pageTotal).not.toHaveBeenCalled();
  });
});

describe("DefaultPolicy acting outside the allowlist", () => {
  it("refuses to act on a page outside the run's allowlist, pre-approval or not", async () => {
    // The allowlist covers where the agent acts, not only where it navigates (agent.ts re-checks the
    // page the action led to as a navigation, so this is the same rule applied to the starting page).
    const d = await clickOn("Pay $5.00", { allowedHosts: ["shop.example.com"], preApproved: PAY_UP_TO_200 }, { url: "https://evil.example.net/cart" });
    expect(d.kind).toBe("deny");
    expect((d as { reason: string }).reason).toContain("is not in the allowed list");
    expect((await clickOn("Pay $5.00", { allowedHosts: ["*.example.com"], preApproved: PAY_UP_TO_200 })).kind).toBe("allow");
  });

  it("does not apply the private-network guard to acting on a page, only to navigating", async () => {
    // A redirect onto a private address is caught by the agent's post-action re-check as a navigation;
    // the policy on its own lets an action on an already-private page through.
    expect((await clickOn("Continue", {}, { url: "http://127.0.0.1:7700/admin" })).kind).toBe("allow");
  });
});

describe("a cart edit", () => {
  const raw = (target: string) => new DefaultPolicy().check({ tool: "click", input: { ref: "e1" }, url: "https://www.swiggy.com/instamart/cart", target, task: "swap the milk" });

  it("taking an item out of a cart, or one fewer, needs no approval (6 Nov: Swiggy's minus asked twice)", async () => {
    expect((await raw('[e14]<button aria-label="Remove 1 item from cart" data-testid="add_buttons_minus">−</button>')).kind).toBe("allow");
    expect((await clickOn("Remove from basket")).kind).toBe("allow");
    expect((await clickOn("Remove item from your bag")).kind).toBe("allow");
    expect((await clickOn("Decrease quantity")).kind).toBe("allow");
  });

  it("a deletion that is not a cart edit still asks", async () => {
    expect((await clickOn("Delete account")).kind).toBe("confirm");
    expect((await clickOn("Remove payment method")).kind).toBe("confirm");
    expect((await raw('[e3]<button aria-label="Remove 1 item from cart">Delete account</button>')).kind).toBe("confirm");
    expect((await clickOn("Place order")).kind).toBe("confirm");
  });
});

describe("a payment the person's own words approve (11 Nov)", () => {
  it("needs a payment asked for, how or that it goes ahead, and nothing holding it back", () => {
    const yes = [
      "Book the 7 am yoga class tomorrow and pay with my saved card",
      "Order 2 kg onions on BigBasket and pay using my wallet balance",
      "Renew my car insurance on Acko, apply the coupon SAVE10 and pay with the saved UPI",
      "Buy the cheapest USB-C cable on Amazon, go ahead and place the order",
      "Book a coworking day pass for tomorrow using my credits",
      "Recharge my Jio number with the ₹299 plan, pay with my default card, no need to ask me",
    ];
    for (const t of yes) expect(payApprovedByWords(t), t).toBe(true);
    const no = [
      "Find the cheapest flight from Delhi to Mumbai next Friday",
      "Add the cheapest USB-C cable to my cart",
      "Book a table for 2 at Toit tomorrow at 8 pm",
      "Book the room with my saved card but ask me before paying",
      "Check if my saved card is still on file on Amazon",
      "Order it with my saved card, but don't pay yet, leave it in the cart",
      "Just compare the prices of the iPhone 17 on Flipkart and Amazon",
    ];
    for (const t of no) expect(payApprovedByWords(t), t).toBe(false);
    expect(asksToPay("Book a table for 2")).toBe(true);
    expect(asksToPay("Send an email to Ada")).toBe(false);
  });

  it("any final step the words ask for, each on its own; moving money needs \"go ahead\" said; a draft or \"ask me first\" approves none", () => {
    expect(approvedByWords("Post 'We are hiring' on my LinkedIn")).toEqual(["send"]);
    // "Make the payment" asks to pay (17 Nov: three follow-ups saying so each stopped at a confirm).
    expect(approvedByWords("make the payment - i'll share details and store it to vault as well")).toEqual(["pay"]);
    expect(approvedByWords("ok makethe upi payment and tell me - i'll make it here only")).toEqual(["pay"]);
    expect(approvedByWords("use the coupon and complete the payment, dont ask")).toEqual(["pay"]);
    expect(approvedByWords("how do I make a payment?")).toEqual([]);
    expect(approvedByWords("tell me the payment options")).toEqual([]);
    // Being told at the payment step holds paying back.
    expect(approvedByWords("add this and proceed, notify me at payment")).toEqual([]);
    expect(holdsBack("now proceed and notify ,e at payment")).toBe(true);
    expect(holdsBack("add it to the cart and stop at checkout")).toBe(true);
    expect(holdsBack("order it and tell me the order number")).toBe(false);
    expect(approvedByWords("Reply to the latest email from Ada saying yes, Thursday works")).toEqual(["send"]);
    expect(approvedByWords("Cancel my Netflix subscription")).toEqual(["cancel"]);
    expect(approvedByWords("Delete my old office address from my Amazon account")).toEqual(["delete"]);
    expect(approvedByWords("Transfer 500 rupees to Ravi on Paytm")).toEqual([]);
    expect(approvedByWords("Transfer 500 rupees to Ravi on Paytm, go ahead without asking")).toEqual(["transfer"]);
    expect(approvedByWords("Draft a reply to Ada's email")).toEqual([]);
    expect(approvedByWords("Cancel my Netflix subscription but ask me first")).toEqual([]);
    expect(approvedByWords("Write the LinkedIn post but don't post it yet")).toEqual([]);
    expect(approvedByWords("Find the top 5 posts on r/india this week")).toEqual([]);
  });

  it("reads a spending limit only where the words make one", () => {
    expect(spendCapIn("pay with my saved card, under ₹2,000")).toMatchObject({ value: 2000, currency: "INR" });
    expect(spendCapIn("budget of $50, go ahead and pay")).toMatchObject({ value: 50, currency: "USD" });
    expect(spendCapIn("buy the $45 one and pay with my saved card")).toBeNull();
  });

  it("an approval added during the run lets the pay step through, within a limit the job set, and nothing else", async () => {
    const policy = new DefaultPolicy();
    const ctx = { tool: "click" as const, input: { ref: "e1" }, url: "https://shop.example.com/cart", target: "<button>Pay $45.00</button>", task: "buy it" };
    confirm(await policy.check(ctx));
    policy.approve({ kinds: ["pay"] });
    expect(allow(await policy.check(ctx)).note).toBe("pre-approved pay");
    confirm(await policy.check({ ...ctx, target: "<button>Delete account</button>" }));
    // A job's own limit stays, and the stricter wins.
    const capped = new DefaultPolicy({ preApproved: { kinds: ["send"], maxAmount: 40, currency: "USD" } });
    capped.approve({ kinds: ["pay"], maxAmount: 100, currency: "USD" });
    expect(confirm(await capped.check(ctx)).reason).toContain("is over the pre-approved 40 USD");
    expect(allow(await capped.check({ ...ctx, target: "<button>Pay $35.00</button>" })).note).toContain("within 40 USD");
  });
});

describe("a trial run before a schedule (11 Nov)", () => {
  it("walks up to the final step and never takes it, whatever is pre-approved", async () => {
    const trial = new DefaultPolicy({ trial: true, preApproved: { kinds: ["pay", "send", "delete", "cancel"] } });
    const click = (label: string) => trial.check({ tool: "click", input: { ref: "e1" }, url: "https://shop.example.com/checkout", target: `<button>${label}</button>`, task: "book it" });
    for (const label of ["Place order", "Confirm booking", "Pay ₹750", "Submit", "Book now", "Send message", "Cancel subscription", "Delete account"]) {
      const d = await click(label);
      expect(d.kind, label).toBe("deny");
      expect((d as { reason: string }).reason, label).toContain("Trial run:");
    }
    for (const label of ["Book a day pass", "Select Embassy One", "Continue", "Next", "Sign in", "Search"]) expect((await click(label)).kind, label).toBe("allow");
  });
});

describe("checkout and corrections", () => {
  it("going to the checkout page is no payment; paying, placing the order and a bare Checkout still are", async () => {
    const p = new DefaultPolicy();
    const at = (label: string) => p.check({ tool: "click", input: { ref: "e1" }, url: "https://shop.example/checkout", target: `[e1]<button type="submit">${label}</button>` } as never);
    for (const label of ["Proceed to Checkout", "Go to checkout", "Continue to Checkout"]) expect([label, (await at(label)).kind]).toEqual([label, "allow"]);
    for (const label of ["Pay & Confirm Booking", "Place order", "Checkout", "Secure checkout", "Buy now"]) expect([label, (await at(label)).kind]).toEqual([label, "confirm"]);
  });

  it("a message asks for a step of its own, or holds one back", () => {
    expect(asksForWrite("now order a pizza from Domino's")).toBe(true);
    expect(asksForWrite("it in pune - your are chekcing mumbai")).toBe(false);
    expect(asksForWrite("the blue one then")).toBe(false);
    expect(holdsBack("actually don't book it, just tell me today's price")).toBe(true);
    expect(holdsBack("ask me before paying")).toBe(true);
    expect(holdsBack("Bangalore, not Chennai")).toBe(false);
  });
});


describe("a final step is on what the person named (19 Nov)", () => {
  it("reads what a request's book, order or buy is for, with generic words, times and how it is paid left out", async () => {
    const { namedObject, namedFor } = await import("./policy.js");
    expect(namedObject("book lvp for me today")).toEqual(["lvp"]);
    expect(namedObject("book northgate for me today, at checkout apply the best coupon")).toEqual(["northgate"]);
    expect(namedObject("Book a desk at LVP Lakeview Plaza tomorrow 9am with my membership")).toEqual(["lvp", "lakeview", "plaza"]);
    expect(namedObject("order amul gold full cream milk and place the order with cod")).toEqual(["amul", "gold", "full", "cream", "milk"]);
    expect(namedObject("book the same one again")).toEqual([]);
    expect(namedObject("what did it cost?")).toEqual([]);
    // A follow-up that continues an unfinished request: a new name is the thing; a move of its place is not.
    const carried = "book northgate for me today, at checkout apply the best coupon";
    expect(namedFor("lvp", carried)).toEqual(["lvp"]);
    expect(namedFor("no, the lvp one", carried)).toEqual(["lvp"]);
    expect(namedFor("it in riverside - you are checking the wrong city", carried)).toEqual(["northgate"]);
    expect(namedFor("it's in Bangalore", carried)).toEqual(["northgate"]);
    expect(namedFor("book lvp", carried)).toEqual(["lvp"]);
    expect(namedFor("lvp")).toEqual([]);
  });

  it("a step the words rule out names nothing, and a long follow-up is instructions, not a name (23 Nov)", async () => {
    const { namedObject, namedFor } = await import("./policy.js");
    expect(namedObject("DO NOT book or pay anything - search and report prices only.")).toEqual([]);
    expect(namedObject("I don't want to order the milk, just tell me the price")).toEqual([]);
    expect(namedObject("Find flights; never book anything.")).toEqual([]);
    // Still a request: the negation is about something else.
    expect(namedObject("don't forget to book lvp for me today")).toEqual(["lvp"]);
    const carried = "Find the cheapest ROUND-TRIP flights for 2 adults. DO NOT book or pay anything - search and report prices only.";
    expect(namedFor("Finish the remaining gaps, be efficient with steps. You already observed these cheapest round-trip totals for 2 adults (VND): Dec 2-7: 6,073,204", carried)).toEqual([]);
    // A long message continuing a request that names something keeps that request's name, not its own words.
    expect(namedFor("you are checking the wrong city, the place is in the riverside district near the old bus stand, check the map and the opening hours carefully", "book northgate for me today")).toEqual(["northgate"]);
  });

  it("matches a page by every named word, a plural, a one-letter typo or a city's other name", async () => {
    const { objectShown } = await import("./policy.js");
    const northgate = "Northgate Tower, Hillside, Bengaluru — Day pass ₹750. Pay & Confirm Booking";
    expect(objectShown(["lvp"], northgate)).toBe(false);
    expect(objectShown(["northgate"], northgate)).toBe(true);
    expect(objectShown(["lvp"], "LVP Lakeview Plaza, Riverside, Bengaluru")).toBe(true);
    expect(objectShown(["lvp", "plaza"], "LVP Lakeview Annex, Eastbay")).toBe(false);
    expect(objectShown(["headphones"], "Sony WH-1000XM5 Wireless Headphone")).toBe(true);
    expect(objectShown(["northgote"], northgate)).toBe(true);
    expect(objectShown(["bangalore"], northgate)).toBe(true);
  });

  it("booking controls are final steps; choosing one is not", async () => {
    const p = new DefaultPolicy();
    const at = (target: string) => p.check({ tool: "click", input: { ref: "e1" }, url: "https://desks.example/checkout", target, task: "book lvp" });
    for (const t of ["<button>Book now</button>", "<button>Confirm booking</button>", "<button>Book</button>", "<button> Reserve </button>", "<button>Confirm & book</button>", "<a>Complete your reservation</a>"]) {
      const d = await at(t);
      expect([t, d.kind, (d as { write?: string }).write]).toEqual([t, "confirm", "pay"]);
    }
    for (const t of ["<a>Book a day pass</a>", "<button>Select Northgate Tower</button>", "<a>My bookings</a>", "<a>Booking.com</a>", "<a>Books</a>", "<button>Continue</button>"]) expect([t, (await at(t)).kind]).toEqual([t, "allow"]);
  });

  it("an approved pay step on a page that does not show what the person named is asked about, saying so; on the named thing it goes through", async () => {
    const p = new DefaultPolicy();
    p.approve({ kinds: ["pay"] });
    p.expect(["lvp"]);
    const pay = (page: string) => p.check({ tool: "click", input: { ref: "e1" }, url: "https://desks.example/checkout", target: "<button>Pay & Confirm Booking</button>", task: "lvp", pageText: async () => page });
    const wrong = await pay("Northgate Tower, Hillside, Bengaluru. Coupon DESK10 applied. Total ₹675");
    expect(wrong.kind).toBe("confirm");
    expect((wrong as { reason: string }).reason).toContain("the person asked for lvp, which this page does not show");
    expect((await pay("LVP Lakeview Plaza, Riverside, Bengaluru. Total ₹675")).kind).toBe("allow");
    // A step whose own words name it needs no page read; one with nothing to read is asked about.
    expect((await p.check({ tool: "click", input: { ref: "e1" }, url: "https://desks.example/x", target: "<button>Pay ₹675 for LVP Lakeview Plaza</button>", task: "lvp" })).kind).toBe("allow");
    expect((await p.check({ tool: "click", input: { ref: "e1" }, url: "https://desks.example/x", target: "<button>Pay ₹675</button>", task: "lvp" })).kind).toBe("confirm");
    // Nothing named: as before.
    p.expect([]);
    expect((await pay("Northgate Tower, Hillside")).kind).toBe("allow");
  });
});

describe("DefaultPolicy: a sign-in code sent to the person is not a send (24 Nov, Zomato)", () => {
  const onPage = (tool: "click" | "page_tool", words: string) =>
    new DefaultPolicy().check(
      tool === "click"
        ? { tool: "click", input: { ref: "e1" }, url: "https://accounts.example.com/login", target: `<button role="button">${words}</button>`, task: "log in to my account" }
        : { tool: "page_tool", input: { tool: "t" }, url: "https://www.example.com/", target: `<page-tool name="t">${words}</page-tool>`, task: "log in to my account" },
    );

  it("lets the code and link buttons of a sign-in through, by click or page tool", async () => {
    for (const words of ["Send One Time Password", "Send OTP", "Get OTP", "Resend code", "Send verification code", "Email me a login link", "Request a new code", "Text me a code", "request login otp"]) {
      expect((await onPage("click", words)).kind, words).toBe("allow");
      expect((await onPage("page_tool", words)).kind, words).toBe("allow");
    }
  });

  it("still asks about a real send", async () => {
    for (const words of ["Send message", "Send", "Send email", "Send gift code to a friend", "Post", "Share"]) expect(await onPage("click", words), words).toMatchObject({ kind: "confirm", write: "send" });
  });
});
