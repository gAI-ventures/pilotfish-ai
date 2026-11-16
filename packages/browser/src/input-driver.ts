// How a host shapes a page's input when `Page.humanize` is on: pointer paths, pauses, button and key holds, typing
// pace and wheel deltas. A host registers a driver factory at startup (setInputDriver); the core ships none. With no
// driver registered, or `humanize` off, input is plain: one jump per move, a short press, inserted text, one wheel
// event per scroll.

import type { Page, Point, Rect } from "./page.js";

/** A pointer position and the wait after it, before the next one (ms). */
export interface PathPoint extends Point {
  delayMs: number;
}

/** A pause before part of an input action. */
export type InputPause =
  /** On the target, before a press. */
  | "dwell"
  /** After moving again to a target that moved during the approach, before the press. */
  | "reaim"
  /** After the button goes down for a drag, before the first move. */
  | "grip"
  /** After a drag's last move, before the button goes up. */
  | "release"
  /** From the mouse to the keys, before a field is cleared. */
  | "keys"
  /** Between the presses of a double click. */
  | "between-clicks"
  /** After Shift goes down for a shifted character, before its key. */
  | "shift-down"
  /** After a shifted character's key goes up, before Shift does. */
  | "shift-up"
  /** After a wheel flick that brings a click's target toward the viewport. */
  | "scroll-follow";

/** How short text is typed key by key. */
export interface TypingPace {
  /** How long a key is held (ms). */
  holdMs(): number;
  /** The gap after a key before the next (ms). */
  gapMs(): number;
  /** How many keys until the next short break. */
  breakEvery(): number;
  /** A short break's length (ms). */
  breakMs(): number;
}

export interface InputDriver {
  /** The pointer's path from `from` to `to`; the last point is `to`, with no delay after it. */
  path(from: Point, to: Point, o: { targetWidth?: number; viewport?: { width: number; height: number }; drag?: boolean }): PathPoint[];
  /** A pause before a part of an action (ms; 0 for none). */
  pause(kind: InputPause): number;
  /** How long one press of a click holds the button (ms). */
  pressMs(): number;
  /** How long press() holds a key when the caller gives no delay (ms). */
  keyHoldMs(): number;
  /** Where in a hit-tested box to press (the centre is `centre`). */
  aim(centre: Point, rect: Rect): Point;
  /** How `text` is typed key by key, or null to insert it at once (secrets and password fields are always inserted). */
  typing(text: string): TypingPace | null;
  /** The wheel events a scroll of `delta` px is sent as (signed like it), and the gap after each (ms). */
  wheel(delta: number): number[];
  wheelGapMs(): number;
  /** Where in the viewport a wheeled-to target should land, as a share of its height (0-1). */
  wheelLand(): number;
  /** Whether a click wheels its main-frame target toward the viewport before scrolling it into view. */
  readonly wheelIntoView: boolean;
  /** Keep the pointer moving a little while nothing else drives it, until `signal` aborts (Page.idle). */
  idle?(signal: AbortSignal): Promise<void>;
}

/** Makes a page's driver, the first time the page sends input with `humanize` on. */
export type InputDriverFactory = (page: Page) => InputDriver;

// Kept on globalThis: a process may load this module twice (a package's source and its build output, in tests), and
// both must see the one factory the host registered.
const SLOT = Symbol.for("pilotfish.inputDriver");
type Slot = { [SLOT]?: InputDriverFactory | null };

/** Register the factory every page uses under `humanize` (null: none, plain input). */
export function setInputDriver(f: InputDriverFactory | null): void {
  (globalThis as Slot)[SLOT] = f;
}

/** The registered factory, or null. */
export function inputDriver(): InputDriverFactory | null {
  return (globalThis as Slot)[SLOT] ?? null;
}
