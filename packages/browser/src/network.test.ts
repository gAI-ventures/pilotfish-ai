import { describe, expect, it } from "vitest";
import { isNoiseRequest, siteOf } from "./network.js";

describe("siteOf", () => {
  it("keeps the registrable part, including short second-level labels", () => {
    expect(siteOf("www.amazon.in")).toBe("amazon.in");
    expect(siteOf("unagi.amazon.in")).toBe("amazon.in");
    expect(siteOf("www.airbnb.co.in")).toBe("airbnb.co.in");
    expect(siteOf("shop.example.com.au")).toBe("example.com.au");
    expect(siteOf("localhost")).toBe("localhost");
  });
  it("follows the Public Suffix List, private section included, and keeps IP addresses whole", () => {
    expect(siteOf("pay.amazon.co.uk")).toBe("amazon.co.uk");
    expect(siteOf("foo.gov.in")).toBe("foo.gov.in");
    expect(siteOf("ada.github.io")).toBe("ada.github.io");
    expect(siteOf("shop.myshopify.com")).toBe("shop.myshopify.com");
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("[::1]")).toBe("::1");
    expect(siteOf("WWW.Example.COM.")).toBe("example.com");
  });
});

describe("isNoiseRequest", () => {
  const page = "www.amazon.in";
  it("treats first-party action requests as signal", () => {
    expect(isNoiseRequest("https://www.amazon.in/cart/add-to-cart/ref=dp_start-bbf_1_glance", page)).toBe(false);
    expect(isNoiseRequest("https://www.amazon.in/gp/cart/view.html", page)).toBe(false);
    expect(isNoiseRequest("https://login.amazon.in/ap/signin", page)).toBe(false);
  });
  it("drops telemetry on first-party subdomains (seen live on Amazon)", () => {
    expect(isNoiseRequest("https://unagi.amazon.in/1/events/com.amazon.csm.csa.prod", page)).toBe(true);
    expect(isNoiseRequest("https://fls-eu.amazon.in/1/batch/1/OE/", page)).toBe(true);
    expect(isNoiseRequest("https://aax-eu-zaz.amazon.in/x/px/abc", page)).toBe(true);
  });
  it("drops third-party traffic", () => {
    expect(isNoiseRequest("https://www.google-analytics.com/g/collect?v=2", page)).toBe(true);
    expect(isNoiseRequest("https://aax-eu.amazon-adsystem.com/e/dtb/bid", page)).toBe(true);
  });
});

describe("NetworkTracker: WebSockets (9 Nov, Wolfram|Alpha's results come as frames)", async () => {
  const { NetworkTracker } = await import("./network.js");
  const fake = () => {
    const handlers = new Map<string, (e: unknown) => void>();
    const session = { on: (event: string, fn: (e: unknown) => void) => (handlers.set(event, fn), () => handlers.delete(event)) };
    return { tracker: new NetworkTracker(session as never), emit: (event: string, e: unknown) => handlers.get(event)?.(e) };
  };

  it("tracks a socket an action opened or sent on, and leaves out third parties", () => {
    const { tracker, emit } = fake();
    const since = Date.now();
    emit("Network.webSocketCreated", { requestId: "1", url: "wss://gateway.wolframalpha.com/gateway" });
    emit("Network.webSocketCreated", { requestId: "2", url: "wss://nexus-websocket-a.intercom.io/pubsub" });
    const third = (url: string) => isNoiseRequest(url, "www.wolframalpha.com");
    expect(tracker.socketsSince(since, third).map((s) => s.url)).toEqual(["wss://gateway.wolframalpha.com/gateway"]);
    // Still connecting: busy.
    expect(tracker.socketBusy(1_000, third)).toBe(true);
    emit("Network.webSocketHandshakeResponseReceived", { requestId: "1" });
    emit("Network.webSocketFrameSent", { requestId: "1" });
    emit("Network.webSocketFrameReceived", { requestId: "1" });
    const s = tracker.socketsSince(since, third)[0]!;
    expect(s.open).toBe(true);
    expect(s.lastSent).toBeGreaterThan(0);
    expect(s.lastReceived).toBeGreaterThan(0);
    expect(tracker.socketBusy(1_000, third)).toBe(true);
    expect(tracker.socketBusy(1_000, third, Date.now() + 5_000)).toBe(false);
    // Closed: gone. An old socket that sends nothing during an action is not counted for it.
    emit("Network.webSocketClosed", { requestId: "1" });
    expect(tracker.socketsSince(since, third)).toEqual([]);
    expect(tracker.socketsSince(Date.now() + 1, third)).toEqual([]);
  });

  it("does not count sockets as pending requests", () => {
    const { tracker, emit } = fake();
    emit("Network.requestWillBeSent", { requestId: "1", type: "WebSocket", request: { url: "wss://x.example/ws", method: "GET" } });
    emit("Network.webSocketCreated", { requestId: "1", url: "wss://x.example/ws" });
    expect(tracker.pendingCount()).toBe(0);
  });
});
