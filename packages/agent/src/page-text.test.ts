// The words a site uses to say it is still working, and that a search found nothing (agent.ts: SITE_WAIT_TEXT in
// LOADING_INDICATOR_JS, EMPTY_RESULTS_TEXT in EMPTY_RESULTS_JS). Lines from real pages, and look-alikes that are not.
import { describe, expect, it } from "vitest";
import { EMPTY_RESULTS_TEXT, SITE_WAIT_TEXT } from "./agent.js";

describe("SITE_WAIT_TEXT: the site says it is still working", () => {
  it.each([
    "Loading…",
    "Loading results...",
    "Searching flights…",
    "Fetching the best prices...",
    "Calculating your quote…",
    "Computing…",
    "Looking for available rooms...",
    "Please wait",
    "Please wait while we check availability",
    "Redirecting in 5 seconds",
    "You will be redirected in 10 s",
    "Please wait 8 seconds",
  ])("waits on %j", (t) => expect(SITE_WAIT_TEXT.test(t)).toBe(true));

  it.each([
    "Searching for a job?",
    "Loading docks and warehouses",
    "Loading",
    "Searching made easy. Try it now.",
    "Free delivery in 2 days",
    "Checking account",
    "Updated 5 seconds ago and more text that runs on well past the length a short status line would have",
  ])("does not wait on %j", (t) => expect(SITE_WAIT_TEXT.test(t)).toBe(false));
});

describe("EMPTY_RESULTS_TEXT: a search or filter that found nothing", () => {
  it.each([
    "Sorry, your query returned no results",
    "No results found",
    "No results for “SimCSE”",
    "0 results",
    "0 properties are available in and around this destination",
    "No matching flights",
    "Your search did not match any documents.",
    "We couldn't find any results for that search",
    "Nothing found",
    "No hotels match your filters",
  ])("notes %j", (t) => expect(EMPTY_RESULTS_TEXT.test(t)).toBe(true));

  it.each([
    "Results 1-50 of 62",
    "No-fuss returns within 30 days",
    "0 items in your cart",
    "Showing 12 products",
    "Nothing beats a fresh pizza",
    "No reviews yet",
  ])("leaves %j alone", (t) => expect(EMPTY_RESULTS_TEXT.test(t)).toBe(false));
});
