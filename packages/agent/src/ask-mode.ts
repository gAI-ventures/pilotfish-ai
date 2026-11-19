// How much a run asks the person (19 Nov; the app's Auto / Manual / Accept all, the API's askMode). Its own module, so
// a test that mocks agent.js still has these: the orchestrator puts askModeNote in the executor's brief.

/** How much a run asks the person (AgentOptions.askMode). */
export type AskMode = "auto" | "manual" | "accept_all";

/** What an accept-all run's executor hears when it asks the person to choose (AgentOptions.askMode). */
export const ACCEPT_ALL_REFUSAL =
  "Not asked: this run is set to accept all, so you decide choices yourself instead of asking. Decide from, in this order: the task's own words, the session's earlier turns and what the person told them, then what the site shows (its default, its best match for the task). Go on with that choice now, and say in your result what you chose and why. " +
  "Only what no decision can give goes to the person: a sign-in, a code, a check (their own kinds), and a value only they have (their address, a phone number), asked with `questions` fields that list no options. A final step (pay, send, delete) still needs their words or their yes, as in every run.";

/** The executor brief's line for a run that asks more, or less, than by default (AgentOptions.askMode). */
export function askModeNote(mode: AskMode | undefined): string {
  if (mode === "manual")
    return "ASK MODE: manual. The person wants to make the choices: before acting on anything the task leaves open or unclear (which of several matching items, a date or time, a place, a variant, an option, a seat, a plan), ask them with ask_user `questions`, listing the options the page shows, all such questions at once; never pick for them. What the task, the earlier turns or their messages already settle is used as given, never asked.";
  if (mode === "accept_all")
    return "ASK MODE: accept all. Never ask the person to choose: decide every open choice yourself, from the task's words first, then the session's earlier turns and what the person told them, then what the site shows. Say in your result what you chose and why. Sign-ins, codes, checks and a value only the person has still go to them, and a final step (pay, send, delete) still needs their words or their yes.";
  return "";
}
