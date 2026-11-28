import { describe, expect, it } from "vitest";
import { LEAVES_CHOICE } from "./agent.js";
import { SecretBroker, digitsShown } from "./secrets.js";

// done(success=false) results, labelled: does the result leave the person a decision the run could ask them while they
// are there (`askPersonNote`)? Written beside the 28 Nov cart run; the other wordings are the kinds runs end with.
const CHOICES: string[] = [
  "Chana: choose whether to add one of the plain packs above without a verified ingredients list, or to leave chana out.",
  "Do you want me to book the 9:40 flight instead?",
  "Would you like me to use the Work address?",
  "Should I add the 500 g pack instead?",
  "Adding the substitute needs your approval.",
  "Let me know whether to go ahead with the 330 ml can.",
  "Tell me which of the two you prefer.",
  "If you approve, I can add the 200 g pack.",
  "It's your call whether to keep the 2-pack line.",
  "Decide which seat you want: 12A (window) or 12C (aisle).",
  "Please confirm whether you want the refundable fare.",
  "Pick between the two plans and I will add it.",
];
const NOT_CHOICES: string[] = [
  "Let me know if you need anything else.",
  "I used your choice of address (Home).",
  "The site should include the price on the next page.",
  "I could not find the item; it is out of stock.",
  "I compared 2 of the 10 date pairs you asked for.",
  "You chose the Hebbal address, and the cart is open.",
  "The cart is built except for the chana, which no product page lists ingredients for.",
  "The site asks me to sign in before it shows prices.",
  "I would like to note that the fees changed.",
  "Your order is not placed; I stopped at the cart as asked.",
];

describe("LEAVES_CHOICE", () => {
  it.each(CHOICES)("a choice: %s", (s) => expect(LEAVES_CHOICE.test(s)).toBe(true));
  it.each(NOT_CHOICES)("no choice: %s", (s) => expect(LEAVES_CHOICE.test(s)).toBe(false));
});

describe("a secret drawn on the page (SecretBroker.shownIn, 28 Nov)", () => {
  const phone = new SecretBroker({ "shop.test.entered_phone": { value: "+919876543210", allowedHosts: ["shop.test"] } });
  it("finds a phone number as a page spaces it, or without its country code", () => {
    expect(phone.shownIn("Phone: +91 98765 43210")).toBe(true);
    expect(phone.shownIn("Mobile 98765-43210 (verified)")).toBe(true);
    expect(phone.shownIn("9876543210")).toBe(true);
    expect(phone.shownIn("(987) 654.3210")).toBe(true);
  });
  it("does not find it masked, inside a longer number, or absent", () => {
    expect(phone.shownIn("Phone: +91 98•••••210")).toBe(false);
    expect(phone.shownIn("Order #29876543210 placed")).toBe(false);
    expect(phone.shownIn("Roasted chana 450 g, Rs 84, Flavour: Plain")).toBe(false);
  });
  it("finds an email or a password-like value as written, case aside", () => {
    const b = new SecretBroker({ "shop.test.username": { value: "asha@example.com", allowedHosts: ["shop.test"] } });
    expect(b.shownIn("Signed in as Asha@Example.com")).toBe(true);
    expect(b.shownIn("Signed in as Asha")).toBe(false);
  });
  it("a value too short to tell from other text counts as shown", () => {
    expect(new SecretBroker({ pin: "123" }).shownIn("nothing here")).toBe(true);
  });
  it("digitsShown keeps to whole numbers", () => {
    expect(digitsShown("call 98765 43210 now", "9876543210")).toBe(true);
    expect(digitsShown("call 198765 43210 now", "9876543210")).toBe(false);
    expect(digitsShown("call 98765 432109 now", "9876543210")).toBe(false);
  });
});
