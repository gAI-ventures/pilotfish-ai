import { describe, expect, it } from "vitest";
import { secretAnswer } from "./agent.js";

// Which free-form answers are kept from the model as {{user_code}} (19 Nov review).
describe("secretAnswer", () => {
  it("a code question's one-token answer is a secret, a password question's always", () => {
    expect(secretAnswer("Please share the OTP sent to your phone", "482913")).toBe(true);
    expect(secretAnswer("What is the verification code from the email?", "A7K-29Q")).toBe(true);
    expect(secretAnswer("What's your card PIN?", "4821")).toBe(true);
    expect(secretAnswer("What's the password for the portal?", "Hunter2!")).toBe(true);
    // A password question keeps even a sentence back: secrets never reach the model.
    expect(secretAnswer("Should I sign in with your password or continue as guest?", "continue as guest")).toBe(true);
  });

  it("the person's words to a code question reach the model", () => {
    expect(secretAnswer("Please share the OTP sent to your phone", "I didn't get it, send it to my email")).toBe(false);
    expect(secretAnswer("Enter the verification code", "  resend please ")).toBe(false);
    expect(secretAnswer("Click the verification link we emailed you, then reply 'done'.", "done")).toBe(false);
    expect(secretAnswer("Please share the OTP", "Resend.")).toBe(false);
  });

  it("a postal PIN code is no secret, a card's or bank's PIN is", () => {
    expect(secretAnswer("What's the delivery PIN code for your home address?", "560001")).toBe(false);
    expect(secretAnswer("Which pincode should I deliver to?", "400050")).toBe(false);
    expect(secretAnswer("What's the PIN code of your debit card?", "4821")).toBe(true);
  });

  it("other questions are never secrets", () => {
    expect(secretAnswer("Which colour do you want?", "blue")).toBe(false);
    expect(secretAnswer("What is your company's CIN?", "U72900KA2020PTC123456")).toBe(false);
  });
});
