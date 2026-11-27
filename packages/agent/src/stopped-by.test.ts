import { describe, expect, it } from "vitest";
import { STOPPED_BY } from "./agent.js";

// done(success=false) results, labelled: does the result name something on the site that stopped the work (true: the
// run ends there), or is it a give-up with work left that keep-going should send back once (false)?
export const STOPS: string[] = [
  "The site asks me to sign in before it shows prices.",
  "The flight search showed “Oops, something went wrong” after Reload.",
  "The page says it is not available in your country or region.",
  "Please share the delivery address or area to check the prices on FoodSite.",
  "I need your delivery area before I can check prices.",
  "The site rejected the saved password with 'Incorrect password'.",
  "The account is locked after too many attempts.",
  "A CAPTCHA appeared and I could not get past it.",
  "Access denied: the server returned 403 for every page.",
  "The restaurant is closed right now and not taking orders.",
  "This store does not deliver to Indiranagar.",
  "No flights are available on those dates for that route.",
  "The product is out of stock in every size.",
  "The coupon code was rejected as invalid.",
  "You are not eligible for this offer, the page says.",
  "The minimum order is ₹199 and the cart is ₹120.",
  "The repository is private and this account has no permission to view it.",
  "The form requires an account to submit.",
  "The listing has expired.",
  "The page you asked for was not found (404).",
  "The event was cancelled by the organiser.",
  "The search returned no results for that query.",
  "The booking page timed out twice.",
  "The site requires a subscription to read the article.",
  "Waiting for your answer on which account to use.",
];

export const GIVE_UPS: string[] = [
  "I compared 2 of the 10 date pairs you asked for; the cheapest so far is Dec 22–27 at ₫5,910,724.",
  "I could not complete a reliable comparison of the 10 date pairs or verify three cheapest options. No booking or payment was made.",
  "no flight results with specific times were reached",
  "I checked the first page of listings only; the person may want more.",
  "Found 3 of the 5 leads; the rest need more searching across the region.",
  "I opened the account settings page but did not change the visibility yet.",
  "I ran out of time before checking the country filter.",
  "Only partially done: the cart has the dish, the closed captions setting was not needed.",
  "I filled half of the form; the remaining fields are the address and phone.",
  "Not finished: the third product's price still needs checking.",
];

describe("STOPPED_BY: what stopped the work, not the words of a partial answer", () => {
  it("names real stops", () => {
    for (const s of STOPS) expect(STOPPED_BY.test(s), s).toBe(true);
  });
  it("does not take a partial answer's ordinary words for a stop", () => {
    for (const s of GIVE_UPS) expect(STOPPED_BY.test(s), s).toBe(false);
  });
});
