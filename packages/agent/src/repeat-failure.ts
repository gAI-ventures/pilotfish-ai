/**
 * The same failure from one site, again and again. A site that cannot answer (its servers failing, or refusing this
 * browser without a bot check: a soft block) shows a message such as "Oops, something went wrong", and an agent that
 * reloads and redoes the steps gets the same message each time. The loop rules see different actions and no loop.
 *
 * For example, a travel search answering every query with "Oops, something went wrong" / "No results returned": the
 * executor reloaded, refilled the form and changed filters until its 50 steps ran out, though its plan named another
 * site as well.
 *
 * A failure counts once per turn that ends with it on the screen, if it is new since the turn began, or the turn
 * loaded a new document (a reload, a navigation) or pressed a retry control. A message that stays on the page while
 * the agent works (an error box at the top of a form it is fixing) counts once, not at every action. The third count
 * for one message on one site raises the nudge, once per site.
 */

/**
 * Messages a site shows when it could not do what was asked, in English and the main other languages. Kept to whole
 * phrases so a page that only talks about errors ("Error handling in Java") does not match: a line must also be short
 * (`MAX_LINE`).
 */
export const FAILURE_TEXT = new RegExp(
  [
    // English
    String.raw`\bsomething(?:['’]s| has| had)? (?:went|gone|go(?:es)?) wrong\b`,
    String.raw`\b(?:an?|some) (?:unexpected |unknown |internal |technical )?(?:error|problem|issue) (?:has |have )?(?:occurred|occured|happened)\b`,
    String.raw`\bwe(?:['’]re| are) (?:having|experiencing) (?:some )?(?:technical )?(?:trouble|difficulties|issues|problems)\b`,
    String.raw`\b(?:unable|failed|couldn['’]?t|could not|can['’]?t|cannot) (?:to )?(?:load|fetch|retrieve|get|complete|process|show|display) (?:the |your |any |these |this )?(?:results?|data|flights?|prices?|content|page|request|search|information|items?|offers?|availability|details)\b`,
    String.raw`\bno results (?:were )?returned\b`,
    String.raw`\b(?:service|server|site|page) (?:is )?(?:temporarily )?unavailable\b`,
    String.raw`\btemporarily unavailable\b`,
    String.raw`\binternal server error\b`,
    String.raw`\b(?:bad gateway|gateway time-?out)\b`,
    String.raw`\b(?:request|connection) (?:has )?(?:failed|timed out)\b`,
    String.raw`\b(?:please )?try again (?:later|in a (?:few|little) (?:minutes?|moments?|while))\b`,
    // German, French, Spanish, Portuguese, Italian, Dutch
    String.raw`\bein (?:unerwarteter |technischer )?fehler ist aufgetreten\b`,
    String.raw`\betwas ist schiefgelaufen\b`,
    String.raw`\bune erreur (?:inattendue |technique )?(?:s['’]est produite|est survenue)\b`,
    String.raw`\bun probl[eè]me (?:technique )?est survenu\b`,
    String.raw`\balgo (?:sali[oó] mal|ha salido mal|deu errado)\b`,
    String.raw`\b(?:se ha producido|se produjo|ha ocurrido|ocurri[oó]) un error\b`,
    String.raw`\bocorreu um erro\b`,
    String.raw`\bsi [eè] verificato un errore\b`,
    String.raw`\bqualcosa [eè] andato storto\b`,
    String.raw`\ber (?:is|ging) (?:iets )?(?:een fout opgetreden|iets mis(?:gegaan)?)\b`,
    // Hindi, Japanese, Chinese, Korean (no word boundaries in these scripts)
    "कुछ गलत हो गया",
    "エラーが発生しました",
    "問題が発生しました",
    "出错了|发生错误|出现错误|出了点问题",
    "오류가 발생했습니다|문제가 발생했습니다",
  ].join("|"),
  "i",
);

/** Longer lines are prose about errors, not a site's own message. */
const MAX_LINE = 160;

/** Controls that ask the site to try again. */
const RETRY_LABEL = /\b(?:retry|try again|reload|refresh)\b|erneut versuchen|réessayer|reintentar|tentar novamente|riprova|再試行|重试|다시 시도/i;

/** The page's visible lines that read as a site's own failure message, normalised (case and spacing), at most 6. */
export function failureLines(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line.length > MAX_LINE || !FAILURE_TEXT.test(line)) continue;
    out.add(line.toLowerCase());
    if (out.size >= 6) break;
  }
  return [...out];
}

/** Whether a control's label asks the site to try again. */
export function isRetryLabel(label: string): boolean {
  return RETRY_LABEL.test(label);
}

/** What one turn did, for `RepeatFailures.turn`. */
export interface FailureTurn {
  /** The registrable site of the page the turn ended on. */
  site: string;
  /** Failure lines on the page when the turn began (on that same site; empty when it began elsewhere). */
  before: string[];
  /** Failure lines on the page the turn ended on. */
  after: string[];
  /** The turn loaded a new document (a navigation or a reload). */
  loaded: boolean;
  /** The turn pressed a retry control ("Try again", "Reload"). */
  retried: boolean;
}

/** How many times a message is seen before the nudge. */
export const FAILURE_REPEATS = 3;

/**
 * How many times before the end check is shown the site (and a retry is told not to go back): the same failure again
 * after a retry or the steps redone. 9 Nov, local A/B on gpt-6-luna: at the check, a failing site had answered twice
 * both times the check asked for it to be retried ("Retry the search", "Retry or otherwise verify SkyFind").
 */
export const FAILURE_SHOWN = 2;

/**
 * Counts a site's failure messages over a run. One run's executors share it (the orchestrator passes one to each), so a
 * new attempt in a fresh executor still knows the site's failures, and the end check is shown them (`failing`).
 */
export class RepeatFailures {
  private readonly counts = new Map<string, number>();

  /** Each site whose message came back `min` times or more (default `FAILURE_SHOWN`), with its most repeated message. */
  failing(min = FAILURE_SHOWN): Array<{ site: string; text: string; times: number }> {
    const best = new Map<string, { site: string; text: string; times: number }>();
    for (const [key, times] of this.counts) {
      if (times < min) continue;
      const cut = key.indexOf("\n");
      const site = key.slice(0, cut);
      if ((best.get(site)?.times ?? 0) < times) best.set(site, { site, text: key.slice(cut + 1), times });
    }
    return [...best.values()];
  }

  /** Record a turn; returns the messages this turn counted that have now come back `FAILURE_REPEATS` times or more. */
  turn(t: FailureTurn): Array<{ site: string; text: string; times: number }> {
    if (!t.site) return [];
    const hits: Array<{ site: string; text: string; times: number }> = [];
    for (const line of t.after) {
      if (t.before.includes(line) && !t.loaded && !t.retried) continue;
      const key = `${t.site}\n${line}`;
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      if (n >= FAILURE_REPEATS) hits.push({ site: t.site, text: line, times: n });
    }
    return hits;
  }
}

/** What the model is told when a site keeps answering the same failure. */
export function repeatFailureNudge(f: { site: string; text: string; times: number }): string {
  return (
    `${f.site} has answered "${f.text}" ${f.times} times now, after reloads or redoing the steps. Doing the same again will most likely get the same answer: the site may be failing, or refusing this browser, for now. ` +
    `Do not repeat those steps on ${f.site}. If the task does not require ${f.site}, get the same information from another site that has it (one your plan names, or a well-known alternative) and say which site the answer comes from. ` +
    `If it does, or no other site has it, end with done(success=false) and say what ${f.site} answered.`
  );
}
