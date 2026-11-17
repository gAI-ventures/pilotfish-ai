// Paying the way the person wants (17 Nov, a real order that asked the same payment question three times): when their words name no way to pay and the payment
// page offers more than one, the person picks one on a card of choices read from the page, once, at the pay step. A
// way they named ("with UPI", "use the voucher", "any card is fine") is theirs already: nothing is asked.
import type { SnapNode } from "@pilotfish/perception";

/** Words of a way to pay: a card, UPI or a QR code, a bank, a wallet or balance, vouchers or credits, on delivery, later. */
const METHOD =
  /\b(credit|debit|cards?|upi|scan (and|&) pay|qr( code)?|net ?banking|bank( transfer| account)?|wallet|balance|vouchers?|coupons?|gift ?cards?|promo(tional)? codes?|cash on delivery|pay on delivery|cod|emi|pay ?later|paypal|apple pay|google pay|g ?pay|phone ?pe|paytm|amazon pay|credits|points|miles|klarna|afterpay|affirm|direct debit|ideal|sofort|bancontact|venmo|cash ?app)\b/i;
/** The person leaves the way to pay to the run: "any way", "whichever", "your choice". */
const ANY_WAY = /\b(any|whichever|whatever) (payment )?(way|method|option|mode)\b|\b(any|whichever) (works|is fine)\b|\b(your|you) (choice|call|decide|choose|pick)\b|\bup to you\b/i;
/** A row the site shows but cannot use now. */
const UNUSABLE = /\b(unavailable|not available|insufficient|not eligible|ineligible|disabled|currently not supported)\b/i;

/** The person's own words name a way to pay, or leave it to the run: nothing to ask at the pay step. */
export function payMethodNamed(words: string): boolean {
  return METHOD.test(words) || ANY_WAY.test(words);
}

/** One way to pay the page offers: its words as the page shows them, and whether it is the one picked now. */
export interface PayOption {
  label: string;
  checked: boolean;
  ref?: string;
}

const isChoice = (n: SnapNode): boolean =>
  (n.tag === "input" && /^(radio|checkbox)$/i.test(n.attrs["type"] ?? "")) || /^(radio|checkbox|menuitemradio|switch)$/.test(n.role);

/** The texts inside `n`, depth first, up to `max` characters in all. */
function textsOf(n: SnapNode, max = 240): string[] {
  const out: string[] = [];
  let len = 0;
  const stack = [n];
  while (stack.length && len < max) {
    const c = stack.shift()!;
    const t = c.text?.replace(/\s+/g, " ").trim();
    if (t) {
      out.push(t);
      len += t.length + 1;
    }
    stack.unshift(...c.children);
  }
  return out;
}

/** Whether `a` holds a choice other than `self`. */
function holdsOther(a: SnapNode, self: SnapNode): boolean {
  const stack = [...a.children];
  while (stack.length) {
    const c = stack.pop()!;
    if (c !== self && isChoice(c)) return true;
    stack.push(...c.children);
  }
  return false;
}

/**
 * A choice's words and its row's: its own name when that says a way to pay, else the first phrase of its row (the nearest
 * box around it alone) that does ("Credit or debit card", not the row's "Add a new card" link with it). The row's whole
 * text says whether the page can use it now ("Pay on Delivery" with "Unavailable for this item" beside it).
 */
function labelOf(n: SnapNode): { label: string; row: string } {
  const own = (n.name || n.attrs["aria-label"] || "").trim();
  let a = n.parent;
  for (let i = 0; a && i < 5; i++, a = a.parent) {
    if (holdsOther(a, n)) break;
    const texts = textsOf(a);
    const row = texts.join(" ");
    if (METHOD.test(own)) return { label: own, row: `${own} ${row}` };
    const first = texts.find((t) => METHOD.test(t));
    if (first) return { label: first, row };
  }
  return METHOD.test(own) ? { label: own, row: own } : { label: "", row: "" };
}

/** Short enough for a chip: the row's first sentence or line, at most 70 characters. */
function chip(label: string): string {
  const first = label.split(/(?<=[.!?])\s|\s{2,}/)[0]!.trim();
  return first.length <= 70 ? first : `${first.slice(0, 67).trimEnd()}…`;
}

/**
 * The ways to pay a payment page offers that can be picked now: its radio buttons and checkboxes whose own words, or
 * whose row's words, name a way to pay (a card, UPI, a wallet, vouchers…), less the disabled and the ones the page says
 * are unavailable. One per label, in page order.
 */
export function payOptions(nodes: readonly SnapNode[]): PayOption[] {
  const out: PayOption[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!isChoice(n) || n.disabled || n.visible === false) continue;
    const { label: full, row } = labelOf(n);
    if (!full || UNUSABLE.test(row)) continue;
    const label = chip(full);
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, checked: n.checked === true, ...(n.ref ? { ref: n.ref } : {}) });
  }
  return out;
}

/** Which of `options` the person's answer picked ("Answer: Net Banking" from the card, or their own words), or their words. */
export function pickedOption(answer: string, options: readonly PayOption[]): { label: string; option?: PayOption } {
  const said = (/Answer:\s*(.+)/.exec(answer)?.[1] ?? answer).trim();
  const lower = said.toLowerCase();
  const option = options.find((o) => o.label.toLowerCase() === lower) ?? options.find((o) => lower.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(lower));
  return option ? { label: option.label, option } : { label: said };
}

/** The answer that holds paying back. */
export const NOT_NOW = "Don't pay yet";
