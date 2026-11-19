// Action policy: the hook where allowlists, irreversible-action confirmation
// and (later) an action-verification classifier plug in. Runs before every
// browser-affecting tool call. The default policy: domain allowlist if
// configured, private-network URLs blocked, and confirmation for actions whose
// target looks irreversible (pay, delete, send, transfer, cancel) unless the
// task pre-approved that kind of step (`preApproved`, e.g. checkout up to $200).

import { isIP } from "node:net";
import { isNonPublicAddress } from "@pilotfish/browser";
import type { ToolName } from "./tools.js";

export interface ActionContext {
  tool: ToolName;
  input: Record<string, unknown>;
  /** Current page URL. */
  url: string;
  /** One-line description of the target element, if any. */
  target?: string;
  /** The user's original task. */
  task: string;
  /** The amount the page asks for (its order total), read on demand for a pre-approved payment limit. */
  pageTotal?: () => Promise<Money | null>;
  /** The page's text, read on demand at a pay step when the person named what it is for (`DefaultPolicy.expect`). */
  pageText?: () => Promise<string>;
}

/** Kinds of irreversible step: what a confirmation is about, and what a task can pre-approve. */
export type WriteKind = "pay" | "delete" | "send" | "transfer" | "cancel";

/** Irreversible steps a task approves in advance, so the run does not stop to ask. */
export interface PreApproval {
  kinds: WriteKind[];
  /**
   * Upper bound for pay and transfer steps. The amount is read from the target ("Pay $45.00"), else
   * from the page's total; a step whose amount cannot be read, or is higher, is asked about.
   */
  maxAmount?: number;
  /** ISO code of the bound ("USD", "INR"); an amount shown in another currency is asked about. */
  currency?: string;
  /** Hostname globs the approval holds on. Default: wherever the run may act. */
  hosts?: string[];
}

export interface Money {
  value: number;
  /** ISO code when the text names or implies one ("$" reads as USD). */
  currency?: string;
  text: string;
}

export type PolicyDecision = { kind: "allow"; note?: string } | { kind: "deny"; reason: string } | { kind: "confirm"; reason: string; write?: WriteKind };

export interface ActionPolicy {
  check(ctx: ActionContext): Promise<PolicyDecision> | PolicyDecision;
}

export interface DefaultPolicyOptions {
  /** Hostname globs the agent may navigate to / act on. Empty = any public host. */
  allowedHosts?: string[];
  /** Require confirmation for clicks/submits whose target text matches these (case-insensitive). */
  irreversiblePatterns?: RegExp[];
  /** Allow private/loopback addresses (dev only). */
  allowPrivateNetwork?: boolean;
  /** Irreversible steps the task approved in advance. */
  preApproved?: PreApproval;
  /**
   * A trial run (before a task is scheduled): it walks the task up to its final step and never takes it. Every
   * irreversible step, and any control whose words complete something (confirm, place, pay, submit, book now…), is
   * refused, whatever a pre-approval says, with a note telling the run to stop there and report.
   */
  trial?: boolean;
}

/** Words standing alone in Latin-script text (no letter or digit either side; accented letters count as letters). */
const words = (alternatives: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");

/**
 * The same steps in other languages: a "Jetzt kaufen" or "Pagar" button went through with no approval asked
 * (review, 3 Nov). Strong wordings only: a bare "Comprar" is a shop's menu. Scripts written without spaces
 * between words (Chinese, Japanese) and Devanagari match as written, with no word edges.
 */
const DEFAULT_IRREVERSIBLE_INTL: Array<{ kind: WriteKind; re: RegExp }> = [
  {
    kind: "pay",
    re: words(
      "pagar(?: ahora| agora)?|comprar (?:ahora|agora|ya)|finalizar (?:compra|pedido)|realizar (?:el )?pedido|tramitar pedido|fazer (?:o )?pedido|confirmar (?:pedido|compra|pago|pagamento)|" +
        "payer|acheter maintenant|passer (?:la |ma )?commande|valider (?:la |ma )?commande|confirmer (?:la |ma )?commande|finaliser (?:la |ma )?commande|commander|" +
        "bezahlen|jetzt kaufen|jetzt bezahlen|zahlungspflichtig bestellen|kostenpflichtig bestellen|kauf abschlie(?:ß|ss)en|bestellung (?:absenden|abschicken|best(?:ä|ae)tigen|abschlie(?:ß|ss)en)|" +
        "paga(?: ora)?|acquista ora|conferma (?:l'ordine|ordine|acquisto|pagamento)|effettua (?:l'ordine|ordine)|betalen|nu kopen|bestelling plaatsen|afrekenen|" +
        "zapłać|kup teraz|zamawiam i płacę|kupuję i płacę|satın al|ödeme yap|siparişi (?:tamamla|onayla)|bayar(?: sekarang)?|beli sekarang|buat pesanan",
    ),
  },
  { kind: "pay", re: /भुगतान करें|अभी खरीदें|ऑर्डर करें|ऑर्डर दें|購入する|今すぐ購入|注文を確定|注文する|支払う|立即购买|提交订单|确认支付|立即支付|去付款|付款|결제하기|구매하기|주문하기/u },
  { kind: "delete", re: words("eliminar|borrar|excluir|apagar|supprimer|effacer|löschen|elimina|cancella|verwijderen|usuń|sil") },
  { kind: "delete", re: /削除|删除|삭제|हटाएं|मिटाएं/u },
  { kind: "send", re: words("enviar|publicar|envoyer|publier|senden|absenden|abschicken|veröffentlichen|invia|pubblica|verzenden|versturen|publiceren|wyślij|opublikuj|gönder|yayınla|kirim") },
  { kind: "send", re: /送信|投稿する|发送|发布|보내기|전송|게시|भेजें/u },
  { kind: "transfer", re: words("transferir|virement|transférer|überweisen|überweisung|bonifico|trasferisci|overmaken|przelew|havale|transfer dana") },
  { kind: "transfer", re: /振込|送金|转账|송금|이체|ट्रांसफर/u },
  {
    kind: "cancel",
    re: words(
      "cancelar (?:(?:la |mi |a |minha )?(?:suscripción|cuenta|plan|assinatura|conta|plano))|darse de baja|résilier|se désabonner|kündigen|abbestellen|abo beenden|" +
        "annulla (?:l'abbonamento|abbonamento|iscrizione)|disiscriviti|opzeggen|uitschrijven|anuluj subskrypcję|aboneliği iptal et",
    ),
  },
  { kind: "cancel", re: /解約|退会|取消订阅|注销账户|구독 취소|해지/u },
];

/** A filter or sort in those languages: "Filter löschen", "Eliminar filtros" take a filter off, they delete nothing. */
const FILTER_INTL = words("filter|filtro|filtros|filtre|filtres|filtri|filtry|filtrów|sortierung|ordenación|tri|筛选|フィルター|필터");

const DEFAULT_IRREVERSIBLE: Array<{ kind?: WriteKind; re: RegExp; intl?: boolean }> = [
  // Going to the checkout page ("Proceed to Checkout") commits nothing: the pay step on it does (approvals were once
  // asked twice for "Proceed to Checkout" before the one for "Pay & Confirm Booking").
  { kind: "pay", re: /\b(pay|purchase|buy now|place order|(?<!\b(?:proceed|go|continue|move|head|ready) to )checkout|confirm (order|payment|purchase)|complete (order|purchase))\b/i },
  // A booking is a final step whatever pays for it (a membership's credits, a day pass): "Book now", "Confirm booking"
  // and a bare "Book" or "Reserve" button committed with no gate at all (19 Nov). "Book a day
  // pass" and "Select <venue>" only choose: they stay out.
  { kind: "pay", re: /\b(book now|book (?:it|this)|confirm (?:(?:the|your|my) )?(?:booking|reservation)|complete (?:(?:the|your|my) )?(?:booking|reservation)|reserve now|confirm (?:and|&) book|book (?:and|&) pay|place (?:the |your )?booking)\b|>\s*(?:book|reserve)\s*<|^\s*(?:book|reserve)\s*$/i },
  { kind: "delete", re: /\b(delete|remove|erase|destroy|wipe)\b/i },
  { kind: "send", re: /\b(send|post|publish|tweet|share)\b/i },
  { kind: "transfer", re: /\b(transfer|withdraw|wire)\b/i },
  { kind: "cancel", re: /\b(unsubscribe|cancel (subscription|account|plan)|close account)\b/i },
  ...DEFAULT_IRREVERSIBLE_INTL.map((p) => ({ ...p, intl: true })),
];

/**
 * A control that opens a menu, listbox or dialog commits nothing by itself: the action is the later
 * click on what it opens, which is a different target and is judged on its own. This is the ARIA
 * attribute — a structural signal, not a word in an id or a class.
 */
const OPENS_POPUP = /\baria-haspopup="(true|menu|listbox|dialog)"/i;

/**
 * A control that filters, sorts or refines the page rather than committing anything. Deliberately only
 * the filter and sort words: "menu", "dropdown", "toggle" and "chip" say nothing about what a control
 * does, so reading one as harmless is how a "Delete account" button carrying `id="delete_toggle"` would
 * be clicked with no confirmation and no look at the pre-approval's amount limit.
 *
 * The leading group is `(?:^|[^a-z0-9])` rather than `\b` because these words are read out of
 * identifiers as well as prose, and `_` is a word character: `\bfilter` does not match the `filter` in
 * `id="salaryType_filter_button"`, which is exactly the control this carve-out exists for.
 */
const FILTER_WORDS = /(?:^|[^a-z0-9])(filter\w*|facet\w*|sort\w*|refin\w*)/i;

/**
 * "Purchase" naming a kind of thing, not the step: a facet ("Purchase Type", Steam's reviews filter, which a run on 3 Nov
 * was refused and stopped at), a record ("Purchase history", "Purchase date") or a field. Read only after the step's own
 * wordings (`UNAMBIGUOUS_STEP`) and with no amount on the control.
 */
const PURCHASE_NOUN = /\bpurchase\s+(?:types?|history|histories|dates?|year|price|status|details|summary|options?|method|channel|category|location|records?)\b/gi;

/**
 * A control that takes an item out of a cart, basket or bag, or lowers its quantity ("Remove 1 item from cart", a
 * quantity stepper's minus): undone by adding it back, so it needs no approval. 6 Nov: a Swiggy Instamart cart's
 * "−" (aria-label "Remove 1 item from cart") asked the person twice to swap one milk for another.
 */
const CART_EDIT = /\b(remove|delete)\b[^.<>]{0,30}\b(from|in)\s+(?:the |your |my )?(cart|basket|bag|trolley)\b|\b(decrease|reduce|lower)\s+(?:the\s+|item\s+)?quantity\b/i;

/** A control that takes a filter off — "Remove filter", "Clear all filters", "Reset sort". */
const CLEARS_FILTER = /\b(remove|clear|reset|undo)\s+(?:(?:all|any|the|applied|active|selected)\s+)*(filters?|facets?|sorts?|sorting|refinements?|selections?|criteria)\b/i;

/**
 * Steps whose wording names them beyond doubt. The filter carve-out exists for wording that is
 * *ambiguous* — "Pay" is the salary filter on a job board — so a wording that says one of these is
 * never excused, whatever the page's markup says about it: "Pay now" carrying `id="pay_now_sortable"`
 * is a payment, and "Delete account" carrying an `aria-label="Clear all filters"` is a deletion.
 */
const UNAMBIGUOUS_STEP = /\b(buy now|pay now|place (?:the |your |an )?order|check\s?out|confirm (?:order|payment|purchase)|complete (?:order|purchase)|delete (?:account|item|file|everything|all)|erase|destroy|wipe|send (?:message|email|payment)|transfer (?:funds|money)|close account|cancel (?:subscription|account|plan)|unsubscribe)\b/i;

/**
 * A serialized target line split into what the control *says* and how the page *names it in code*.
 * `describeNode`/`attrString` print `<tag attr="value" …>text</tag>` (or `… />` for an empty one), so
 * the grammar is small and fixed. The two are read separately because only one of them is evidence
 * about what a control does: an id ending in `_filter_button` is how the page declares a filter
 * widget, while a `class` or a query string in an `href` is incidental — and a label that contradicts
 * the visible text is not evidence of anything.
 */
function targetParts(text: string): { says: string; names: string } {
  const attrs = new Map<string, string>();
  for (const m of text.matchAll(/\s([a-z][a-z0-9-]*)="([^"]*)"/gi)) attrs.set(m[1]!.toLowerCase(), m[2]!);
  const open = text.indexOf(">");
  const close = text.lastIndexOf("</");
  const inner = open >= 0 && close > open ? text.slice(open + 1, close) : "";
  const says = [inner, attrs.get("aria-label"), attrs.get("title"), attrs.get("alt"), attrs.get("value"), attrs.get("label"), attrs.get("placeholder")].filter(Boolean).join(" ");
  const names = [attrs.get("id"), attrs.get("name"), attrs.get("data-testid")].filter(Boolean).join(" ");
  return { says, names };
}

export class DefaultPolicy implements ActionPolicy {
  private opts: DefaultPolicyOptions;
  constructor(opts: DefaultPolicyOptions = {}) {
    this.opts = { ...opts };
  }

  /**
   * Adds an approval the task gives in its own words (`payApprovedByWords`), found once the run has its plan. Kinds are
   * joined; an amount limit or hosts already set (the job's own `preApproved`) stay, the stricter of two limits wins.
   */
  approve(extra: PreApproval): void {
    const cur = this.opts.preApproved;
    if (!cur) return void (this.opts = { ...this.opts, preApproved: { ...extra, kinds: [...new Set(extra.kinds)] } });
    const max = cur.maxAmount !== undefined && extra.maxAmount !== undefined ? Math.min(cur.maxAmount, extra.maxAmount) : (cur.maxAmount ?? extra.maxAmount);
    const currency = cur.maxAmount !== undefined ? cur.currency : (extra.currency ?? cur.currency);
    this.opts = { ...this.opts, preApproved: { ...cur, kinds: [...new Set([...cur.kinds, ...extra.kinds])], ...(max !== undefined ? { maxAmount: max } : {}), ...(currency ? { currency } : {}) } };
  }

  /** The words the person named the pay step's object by ("lvp", "full cream milk"), from `namedObject`. */
  private named: string[] = [];

  /**
   * What the person's words say the pay step (book, order, buy) is for: its distinctive words (`namedObject`). A pay
   * step on a page that shows none of them as a whole (the person said "book lvp", the page books another place) is asked
   * about whatever approved it, with the mismatch in the question: an approval is for what the person named, never for
   * another thing (19 Nov). [] clears it.
   */
  expect(words: readonly string[]): void {
    this.named = [...new Set(words.map((w) => w.toLowerCase()).filter(Boolean))];
  }

  check(ctx: ActionContext): PolicyDecision | Promise<PolicyDecision> {
    if (ctx.tool === "navigate") {
      const url = String(ctx.input["url"] ?? "");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { kind: "deny", reason: `Invalid URL: ${url}` };
      }
      if (!["http:", "https:"].includes(parsed.protocol)) return { kind: "deny", reason: `Only http(s) URLs may be opened (got ${parsed.protocol})` };
      if (!this.opts.allowPrivateNetwork && isPrivateHost(parsed.hostname)) {
        return { kind: "deny", reason: `Navigation to private/loopback address ${parsed.hostname} is blocked` };
      }
      if (this.opts.allowedHosts?.length && !this.opts.allowedHosts.some((g) => globHost(g, parsed.hostname))) {
        return { kind: "deny", reason: `Host ${parsed.hostname} is not in the allowed list (${this.opts.allowedHosts.join(", ")})` };
      }
      return { kind: "allow" };
    }
    // Acting on a page outside the allowed hosts (reached by a redirect, a late navigation or a tab)
    // is refused as well: the allowlist covers where the agent acts, not only where it navigates.
    if (this.opts.allowedHosts?.length && /^https?:/i.test(ctx.url)) {
      let host = "";
      try {
        host = new URL(ctx.url).hostname;
      } catch {
        /* unparsable: leave it to the navigate check */
      }
      if (host && !this.opts.allowedHosts.some((g) => globHost(g, host))) {
        return { kind: "deny", reason: `The current page (${host}) is not in the allowed list (${this.opts.allowedHosts.join(", ")}); navigate back to an allowed site first` };
      }
    }
    // A page's own tool (WebMCP, the agent's page_tool): judged like a control, by its name in words (and, when the page
    // marks it consequential, by what it says it does). A form tool that only fills its form commits nothing: its
    // submit button is judged when it is clicked. A consequential one is asked about even when no word names the step,
    // as the page itself says it has consequences; its kind is read from its words where they name one, so a task's
    // pre-approval (or the person's own go-ahead) covers it like the same click.
    if (ctx.tool === "page_tool") {
      if (ctx.input["fillsOnly"] === true) return { kind: "allow" };
      const text = ctx.target ?? "";
      const { says } = targetParts(text);
      const consequential = ctx.input["consequential"] === true;
      if (this.opts.trial && (consequential || TRIAL_COMMIT.test(says))) return { kind: "deny", reason: trialStop(text) };
      const patterns: Array<{ kind?: WriteKind; re: RegExp; intl?: boolean }> = this.opts.irreversiblePatterns?.map((re) => ({ kind: undefined, re })) ?? DEFAULT_IRREVERSIBLE;
      for (const p of patterns) {
        if (!p.re.test(says)) continue;
        if (p.kind === "delete" && CART_EDIT.test(says) && !UNAMBIGUOUS_STEP.test(says)) return { kind: "allow" };
        if (!parseMoney(says) && (CLEARS_FILTER.test(says) || (p.kind === "pay" && FILTER_WORDS.test(says))) && !UNAMBIGUOUS_STEP.test(says)) return { kind: "allow" };
        return this.preApproval({ kind: "confirm", reason: `Target looks irreversible: ${text.slice(0, 160)}`, ...(p.kind ? { write: p.kind } : {}) }, ctx, says);
      }
      if (!consequential) return { kind: "allow" };
      const kind: WriteKind | undefined = PAY_INTENT.test(says) ? "pay" : (Object.keys(STEP_INTENT) as Array<Exclude<WriteKind, "pay">>).find((k) => STEP_INTENT[k].test(says));
      return this.preApproval({ kind: "confirm", reason: `The page marks this tool as having consequences: ${text.slice(0, 160)}`, ...(kind ? { write: kind } : {}) }, ctx, says);
    }
    // The caller sets `submit` for a type that actually submits (the agent computes it from per_key and
    // the field type); a newline in the text alone is not a submit (insertText never presses Enter).
    if (ctx.tool === "click" || (ctx.tool === "type" && ctx.input["submit"] === true) || (ctx.tool === "press" && isSubmitKey(String(ctx.input["key"])))) {
      const text = `${ctx.target ?? ""}`;
      // A control that opens a menu, listbox or dialog changes nothing by itself.
      if (OPENS_POPUP.test(text)) return { kind: "allow" };
      if (this.opts.trial && TRIAL_COMMIT.test(targetParts(text).says)) return { kind: "deny", reason: trialStop(text) };
      const patterns: Array<{ kind?: WriteKind; re: RegExp; intl?: boolean }> = this.opts.irreversiblePatterns?.map((re) => ({ kind: undefined, re })) ?? DEFAULT_IRREVERSIBLE;
      for (const p of patterns) {
        if (!p.re.test(text)) continue;
        if (p.intl && p.kind === "delete" && FILTER_INTL.test(targetParts(text).says) && !parseMoney(text)) return { kind: "allow" };
        // A filter or sort control whose wording reads like a step it is not — "Pay" is the salary filter on
        // a job board, "Remove filter" takes a filter off rather than deleting anything — is let through.
        // The evidence has to be the control's own doing: what it says, or the way the page names it in
        // code (the id ending in `_filter_button`). What it does *not* read is a query string in an href,
        // a class, or a label that contradicts the visible text — an id or a URL merely containing "sort"
        // excuses nothing — and a wording that names the step beyond doubt is never excused at all.
        // Only when the target names no amount either: "Pay $45.00" is a payment wherever it sits.
        // Anything else goes to the pre-approval, which is what bounds the amount.
        const { says, names } = targetParts(text);
        // "Purchase Type" names a filter: with that noun phrase taken out, nothing else reads as a payment.
        if (p.kind === "pay" && !parseMoney(text) && !UNAMBIGUOUS_STEP.test(says) && !p.re.test(text.replace(PURCHASE_NOUN, " "))) continue;
        // Out of a cart, or one fewer: never a payment or a deletion of anything that cannot be added back.
        if (p.kind === "delete" && (CART_EDIT.test(says) || CART_EDIT.test(text)) && !UNAMBIGUOUS_STEP.test(says)) return { kind: "allow" };
        const clearsFilter = CLEARS_FILTER.test(says);
        const namesFilter = p.kind === "pay" && (FILTER_WORDS.test(says) || FILTER_WORDS.test(names));
        if (!parseMoney(text) && (clearsFilter || namesFilter) && !UNAMBIGUOUS_STEP.test(says)) return { kind: "allow" };
        if (this.opts.trial) return { kind: "deny", reason: trialStop(text) };
        return this.preApproval({ kind: "confirm", reason: `Target looks irreversible: ${text.slice(0, 120)}`, ...(p.kind ? { write: p.kind } : {}) }, ctx, text);
      }
    }
    return { kind: "allow" };
  }

  /**
   * A confirmation the task's pre-approval covers becomes an allow, with a note saying so. A pay step on a page that
   * does not show what the person named is never covered: it is asked about, the mismatch said (`expect`).
   */
  private preApproval(d: PolicyDecision & { kind: "confirm" }, ctx: ActionContext, text: string): PolicyDecision | Promise<PolicyDecision> {
    const named = this.named;
    if (d.write !== "pay" || !named.length || objectShown(named, text)) return this.covered(d, ctx, text);
    const read = ctx.pageText ? ctx.pageText().catch(() => "") : Promise.resolve("");
    return read.then((page) =>
      objectShown(named, `${text}\n${page}`) ? this.covered(d, ctx, text) : { ...d, reason: `${d.reason} (the person asked for ${named.join(" ")}, which this page does not show: their approval is for that, not for this)` },
    );
  }

  private covered(d: PolicyDecision & { kind: "confirm" }, ctx: ActionContext, text: string): PolicyDecision | Promise<PolicyDecision> {
    const pre = this.opts.preApproved;
    if (!pre || !d.write || !pre.kinds.includes(d.write)) return d;
    let host = "";
    try {
      host = new URL(ctx.url).hostname;
    } catch {
      /* no page yet: a host rule cannot hold */
    }
    if (pre.hosts?.length && !pre.hosts.some((g) => globHost(g, host))) return { ...d, reason: `${d.reason} (the pre-approval does not cover ${host || "this page"})` };
    if ((d.write !== "pay" && d.write !== "transfer") || pre.maxAmount === undefined) return { kind: "allow", note: `pre-approved ${d.write}` };
    const limit = pre.maxAmount;
    const cur = pre.currency?.toUpperCase();
    const judge = (m: Money | null): PolicyDecision => {
      if (!m) return { ...d, reason: `${d.reason} (the amount could not be read to check the pre-approved limit)` };
      if (cur && m.currency && m.currency !== cur) return { ...d, reason: `${d.reason} (amount ${m.text} is not in ${cur})` };
      if (m.value > limit) return { ...d, reason: `${d.reason} (amount ${m.text} is over the pre-approved ${limit}${cur ? ` ${cur}` : ""})` };
      return { kind: "allow", note: `pre-approved ${d.write}: ${m.text} within ${limit}${cur ? ` ${cur}` : ""}` };
    };
    const inTarget = parseMoney(text);
    if (inTarget) return judge(inTarget);
    return ctx.pageTotal ? ctx.pageTotal().then(judge, () => judge(null)) : judge(null);
  }
}

/** Words of a payment to make: pay, buy, order, check out, book, reserve, subscribe, renew, recharge, top up. */
// "Make the payment", "complete the UPI payment" ask for one too (17 Nov: "make the payment", "ok make the upi payment",
// "use the coupon and make the payment dont ask" each stopped at a confirm, the word "payment" not read as paying).
const PAY_INTENT = /\b(pay|paying|purchase|buy|order|check ?out|book|reserve|subscribe|renew|recharge|top[- ]?up|place (the|my|an?) order)\b|\b(make|complete|finish|do)\s*(the|my|a|this)?\s*([a-z]+ )?payment\b/i;
/** Words saying how, or that it is to be done without asking: a saved method, a wallet, credits, a coupon, "go ahead". */
const PAY_HOW = /\b(saved|stored|default|existing|on file|wallet|balance|credits?|points|miles|coupons?|vouchers?|promo code|gift ?cards?|upi|cash on delivery|cod|net ?banking|go ahead|proceed|without (asking|confirming|checking with me)|(don'?t|do not|no need to) (ask|confirm|check with me)|complete (the|my) (payment|purchase|order|booking)|confirm (the|my) (booking|order|payment|purchase)|make the payment|finish (the|my) (payment|purchase|order|booking))\b/i;
/** Words of each final step to make (pay has its own above): send or post, delete, cancel, transfer. */
const STEP_INTENT: Record<Exclude<WriteKind, "pay">, RegExp> = {
  send: /\b(send|post|publish|tweet|reply|respond|submit|message|e-?mail|dm)\b/i,
  delete: /\b(delete|remove|erase|clear|wipe)\b/i,
  cancel: /\b(cancel|unsubscribe|deactivate|close (my|the) account|end (my|the) (subscription|membership|plan))\b/i,
  transfer: /\b(transfer|send money|wire|withdraw)\b/i,
};
/** Doing it with no stop to confirm, said outright: what moving money needs on top of asking for it. */
const GO_AHEAD = /\b(go ahead|proceed|without (asking|confirming|checking with me)|(don'?t|do not|no need to) (ask|confirm|check with me))\b/i;
/** A message that holds every final step back: ask first, only a draft or a look. */
const HELD_ANY = /\b(ask|check with|confirm with) me (first|before)\b|\b(let|show) me (see|review|check)\b|\b(draft|preview)\b|\b(just|only) (find|search|look|check|compare|read|tell)\b/i;
/** A message that holds one kind back: "don't send it", "before you delete", "without cancelling". */
const HELD: Record<WriteKind, RegExp> = {
  // "Notify me at payment", "stop at checkout": the person pays, or says so, there (17 Nov: "now proceed and notify me at
  // payment" carried an earlier "just order it for me" as approved).
  pay: /\b(don'?t|do not|never|without) (pay|paying|buy|buying|order|ordering|book|booking|check ?out|purchase|place)\b|\bbefore (you )?(pay|paying|buy|buying|book|booking|order|ordering|checkout|checking out)\b|\bleave (it )?in (the|my) (cart|basket|bag)\b|\b(notify|tell|ping|alert|call|ask|wake)\b[^.\n]{0,6}\b(at|before|on|when (you )?(reach|get to|are at))\s+(the\s+)?(payment|checkout|pay(ment)? (page|step))\b|\bstop (at|before) (the )?(payment|checkout|pay(ment)? (page|step))\b/i,
  send: /\b(don'?t|do not|never|without) (send|sending|post|posting|publish|publishing|submit|submitting|reply|replying)\b|\bbefore (you )?(send|sending|post|posting|publish|submitting)\b/i,
  delete: /\b(don'?t|do not|never|without) (delete|deleting|remove|removing)\b|\bbefore (you )?(delete|deleting|remove|removing)\b/i,
  cancel: /\b(don'?t|do not|never|without) (cancel|cancelling|canceling|unsubscribe)\b|\bbefore (you )?(cancel|cancelling|canceling)\b/i,
  transfer: /\b(don'?t|do not|never|without) (transfer|transferring|send money|withdraw)\b|\bbefore (you )?(transfer|transferring)\b/i,
};

/** The message asks for a final step of its own (to pay, buy, book, send, delete, cancel, transfer). */
export function asksForWrite(text: string): boolean {
  return PAY_INTENT.test(text) || Object.values(STEP_INTENT).some((re) => re.test(text));
}

/** The message holds any final step back ("ask me first", "just tell me the price", "don't book it"). */
export function holdsBack(text: string): boolean {
  return HELD_ANY.test(text) || Object.values(HELD).some((re) => re.test(text));
}

/**
 * The final steps the person's own message approves outright, each kind read on its own: it asks for that step and
 * holds nothing back ("ask me first", "just draft it", "don't send it yet"). A payment also needs how or that it goes
 * ahead (a saved method, a wallet, credits, a coupon, "go ahead"), and moving money needs "go ahead" said outright.
 * Read from the person's words only, never a page or an earlier result, so nothing the run reads can approve a step.
 */
export function approvedByWords(text: string): WriteKind[] {
  if (HELD_ANY.test(text)) return [];
  const out: WriteKind[] = [];
  if (PAY_INTENT.test(text) && PAY_HOW.test(text) && !HELD.pay.test(text)) out.push("pay");
  for (const k of ["send", "delete", "cancel", "transfer"] as const) {
    if (!STEP_INTENT[k].test(text) || HELD[k].test(text)) continue;
    if (k === "transfer" && !GO_AHEAD.test(text)) continue;
    out.push(k);
  }
  return out;
}

/** A request to book, order or buy something: what it is for follows the verb. */
const OBJECT_VERB = /\b(?:book(?:ing)?|order|buy|purchase|reserve|get me|pay for)\b/gi;
/** Where the words of what is asked for end: a sentence, a dash, how it is paid for, the next step. */
const OBJECT_END = /[,.;:!?\n(]|\s[-–—]\s|\b(?:with|using|via|on|from|paying|then|under|below|within|around|upto|up to|less than|and (?:then|pay|apply|use|check ?out|proceed|confirm|book|order))\b/i;
/**
 * Words with no name of their own in what a final step acts on: articles, pronouns and prepositions, times and dates,
 * the kinds of thing booked or ordered (a desk, a seat, a slot), and words of the request itself. What is left names
 * the thing ("lvp", "northgate", "full cream milk").
 */
const GENERIC = new Set(
  (
    "a an the my our your his her their me us him them it its this that these those same one ones another other others any some each " +
    "for to of in at on by from into onto near around about as is be are was and or but so if it's its i you we he she they please pls kindly also again just only too " +
    "now today tonight tomorrow yesterday day days daily every each weekday weekdays weekends week weekly weekend month monthly morning afternoon evening night noon am pm hr hrs hour hours " +
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun next this coming " +
    "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec " +
    "desk desks seat seats room rooms table tables slot slots spot spots ticket tickets pass passes booking bookings reservation reservations " +
    "order orders item items thing things stuff place places venue venues location office space workspace coworking cowork center centre " +
    "dedicated hot flexi flexible day-pass meeting conference cabin private open plan membership " +
    "book reserve buy purchase get pay ordering booked bought same usual favourite favorite regular " +
    "cheapest cheaper cheap best better top latest newest new highest lowest rated popular good nice great any first second last nearest closest " +
    "quantity qty pack packs piece pieces pcs unit units size sizes person people pax adult adults guest guests"
  ).split(" "),
);

/**
 * The words the person's request names its final step's object by: after its first book, order or buy that names one, up to where that
 * ends ("with my credits", "and apply the coupon", a comma), with generic words, numbers and times left out. "book lvp
 * for me today" → ["lvp"]; "book a desk at Lakeview Plaza tomorrow" → ["lakeview", "plaza"]; "book the same one" → [].
 */
export function namedObject(text: string): string[] {
  // The first request that names something: "order amul gold milk and place the order with cod" is the milk.
  for (const v of text.matchAll(OBJECT_VERB)) {
    const after = text.slice(v.index! + v[0].length);
    const end = OBJECT_END.exec(after);
    const words = objectWords(end ? after.slice(0, end.index) : after);
    if (words.length) return words;
  }
  return [];
}

/** The distinctive words of a name: lowercased, generic words, numbers and times (9am, 10th, 2l) left out. */
export function objectWords(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? []) {
    if (w.length < 2 || GENERIC.has(w) || /^\d/.test(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out;
}

/** Cities known by two names: either one on the page shows the other. */
const ALSO_KNOWN: Record<string, string> = { bangalore: "bengaluru", bengaluru: "bangalore", gurgaon: "gurugram", gurugram: "gurgaon", bombay: "mumbai", mumbai: "bombay", calcutta: "kolkata", kolkata: "calcutta", madras: "chennai", chennai: "madras", poona: "pune", pune: "poona" };

/** At most one letter changed, added or dropped. */
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * The page (or a control) shows every one of the named words: as a word, or a word it begins (a plural, "LVP" in
 * "LVPLakeview"), a long one with a typo of one letter, or a city by its other name. A word missing means the step is
 * on something else, or on something the page does not name, and either way not on what the person said.
 */
export function objectShown(named: readonly string[], text: string): boolean {
  const seen = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const has = (w: string): boolean => {
    const stem = w.length > 5 ? w.slice(0, w.length - 2) : w;
    for (const s of seen) if (s === w || s.startsWith(stem) || (w.length >= 6 && oneEdit(s, w))) return true;
    return false;
  };
  return named.every((w) => has(w) || (!!ALSO_KNOWN[w] && has(ALSO_KNOWN[w])));
}

/** A correction that moves the earlier request's place ("it's in Bangalore", "it is at Koramangala"), not its object. */
const SCOPE_ONLY = /^\W*(?:no[,.]?\s+)?(?:it'?s|it is|it|its|that'?s|that is|is|located|the place is|the venue is)\s+(?:in|at|near)\b/i;

/**
 * What a run's pay step must be for, from the person's words: their newest message's request ("book lvp" → lvp), else,
 * when it continues an unfinished request, the new name it gives ("lvp" alone, "the LVP one"), else that request's own
 * ("book northgate…" corrected by "it's in Bangalore" → northgate). [] when they name nothing ("book the same one").
 */
export function namedFor(newest: string, carried = ""): string[] {
  const own = namedObject(newest);
  if (own.length || asksForWrite(newest)) return own;
  if (!carried.trim()) return [];
  if (SCOPE_ONLY.test(newest)) return namedObject(carried);
  const fresh = objectWords(newest).filter((w) => !objectWords(carried).includes(w) && !STOP_WORDS.test(w));
  return fresh.length ? fresh : namedObject(carried);
}

/** Words of a correction that are no name: what it says about the earlier turn ("no", "wrong", "checking"). */
const STOP_WORDS = /^(?:no|nope|yes|ok|okay|wrong|not|instead|actually|rather|correct|checking|chekcing|check|looking|searching|showing|you|are|were|did|do|done|said|meant|mean|want|wanted|need|like|go|ahead|proceed|try|that|right|one|other|new|old|first|second|last|from|there|here|go|with|and|or|but|so|then|still|yet|already)$/i;

/** A control whose words complete something: what a trial run stops before. */
const TRIAL_COMMIT = /\b(confirm|complete|place|submit|finish|finali[sz]e|pay|purchase|buy now|check ?out|proceed to (pay|payment|checkout)|send|post|publish|delete|book now|reserve now|cancel (my |the )?(subscription|membership|account|order|booking|plan))\b/i;

/** Why a trial run refuses a step, as the run reads it: stop here and report. */
function trialStop(text: string): string {
  return `Trial run: "${targetParts(text).says.slice(0, 80) || text.slice(0, 80)}" completes the task, so it is not taken. Stop here and call done: report what this step would do, the exact names, times and options the site offers, the account, membership or payment it asks for, and anything you would have had to ask the person.`;
}

/** The words ask for a payment to be made (pay, buy, order, book…), approved or not. */
export function asksToPay(text: string): boolean {
  return PAY_INTENT.test(text);
}

/**
 * The person's own message approves a payment step outright: it asks for one (pay, buy, order, book…), says how or that
 * it is to be done without asking (a saved card, wallet, credits, a coupon; "go ahead"), and holds nothing back ("ask me
 * first", "don't pay yet", "just add it to the cart"). Read from the person's words only, never a page or an earlier
 * result, so nothing the run reads can approve a payment.
 */
export function payApprovedByWords(text: string): boolean {
  return approvedByWords(text).includes("pay");
}

const CAP_WORDS = /\b(under|below|up ?to|upto|at most|max(imum)?|no more than|not more than|within|less than|budget( of| is)?|cap(ped)? at|limit( of)?)\s*$/i;

/** A spending limit the person's words give ("under ₹2,000", "up to $50", "budget of 300 EUR"), or null. */
export function spendCapIn(text: string): Money | null {
  let best: Money | null = null;
  for (const m of text.matchAll(MONEY)) {
    if (!CAP_WORDS.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
    const money = parseMoney(m[0]);
    if (money && (!best || money.value < best.value)) best = money;
  }
  return best;
}

const SYMBOLS: Array<[RegExp, string]> = [
  [/^(us)?\$$/i, "USD"],
  [/^a\$$/i, "AUD"],
  [/^c\$$/i, "CAD"],
  [/^€$/, "EUR"],
  [/^£$/, "GBP"],
  [/^(₹|rs\.?)$/i, "INR"],
];
const AMOUNT = String.raw`\d{1,3}(?:[,\s]\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const MONEY = new RegExp(String.raw`(US\$|A\$|C\$|[$€£₹]|Rs\.?|INR|USD|EUR|GBP|CAD|AUD)\s?(${AMOUNT})|(${AMOUNT})\s?(USD|EUR|GBP|INR|CAD|AUD)\b`, "g");

/** The largest currency amount in a text ("Pay $1,299.00", "₹1,23,456", "45 EUR"), or null. */
export function parseMoney(text: string): Money | null {
  let best: Money | null = null;
  for (const m of text.matchAll(MONEY)) {
    const sym = m[1] ?? m[4] ?? "";
    const value = Number((m[2] ?? m[3] ?? "").replace(/[,\s]/g, ""));
    if (!Number.isFinite(value)) continue;
    const currency = /^[A-Z]{3}$/.test(sym) ? sym : SYMBOLS.find(([re]) => re.test(sym))?.[1];
    if (!best || value > best.value) best = { value, ...(currency ? { currency } : {}), text: m[0].trim() };
  }
  return best;
}

const TOTAL_LABEL = /\b(grand\s*total|order\s*total|total\s*(due|payable|amount|price|to pay)|amount\s*(due|payable|to pay)|net\s*payable|you\s*pay|total)\b/i;
const STRONG_LABEL = /\b(grand\s*total|order\s*total|total\s*(due|payable|to pay)|amount\s*(due|payable|to pay)|net\s*payable|you\s*pay)\b/i;

/**
 * The total a checkout page asks for, from its visible text: the last "grand total / order total /
 * amount payable" line with an amount (an amount on the line after its label counts), else the
 * last plain "total" line. Null when none shows an amount.
 */
export function totalFromText(text: string): Money | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let strong: Money | null = null;
  let plain: Money | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!TOTAL_LABEL.test(line)) continue;
    const m = parseMoney(line) ?? (i + 1 < lines.length ? parseMoney(lines[i + 1]!) : null);
    if (!m) continue;
    if (STRONG_LABEL.test(line)) strong = m;
    else plain = m;
  }
  return strong ?? plain;
}

/**
 * Keys that submit a form or activate the focused control, so an irreversible target in that context
 * must be confirmed. Covers Enter in all its spellings ("Return", "NumpadEnter", "\r", "\n") and Space.
 */
export function isSubmitKey(key: string): boolean {
  // A shortcut like "Control+Enter" / "Meta+Enter" (Gmail, Slack, GitHub "send") submits too: test the
  // final segment after the modifiers.
  const last = key.includes("+") ? key.slice(key.lastIndexOf("+") + 1) : key;
  return /^(enter|return|numpadenter|space)$/i.test(last) || last === " " || last === "\r" || last === "\n";
}

/**
 * A key press that reloads the page: Control/Meta(+Shift)+R, F5 (with any modifier), the browser's refresh key. A
 * reload drops what was chosen on the page (a search's filters, a selected flight) on many sites.
 */
export function isReloadKey(key: string): boolean {
  const parts = key.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  const last = parts.at(-1) ?? "";
  if (last === "f5" || last === "browserrefresh") return true;
  return (last === "r" || last === "keyr") && parts.slice(0, -1).some((m) => ["control", "ctrl", "meta", "cmd", "command"].includes(m));
}

export function isPrivateHost(host: string): boolean {
  // Strip brackets and a trailing dot: "localhost." and "127.0.0.1." resolve the same as without it.
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // A literal address by the shared classifier (every special-purpose range, and an IPv4 address written
  // as IPv6: mapped, compatible, NAT64 or 6to4, hex or dotted). Real hostnames (fcc.gov, fdic.gov) are names.
  return isIP(h) !== 0 && isNonPublicAddress(h);
}

function globHost(glob: string, host: string): boolean {
  if (glob === host) return true;
  if (glob.startsWith("*.")) {
    const base = glob.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return false;
}
