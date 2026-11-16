// Keyboard descriptors for Input.dispatchKeyEvent. Covers what agents actually
// press; unknown single characters fall back to a text key event.

export interface KeyDescriptor {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
  /** Typed with Shift held on a US keyboard (a capital, a shifted symbol). */
  shift?: boolean;
  /** The key's text without Shift ("1" for "!", "a" for "A"). */
  unshifted?: string;
}

const NAMED: Record<string, KeyDescriptor> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Esc: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
  F1: { key: "F1", code: "F1", keyCode: 112 },
  F2: { key: "F2", code: "F2", keyCode: 113 },
  F3: { key: "F3", code: "F3", keyCode: 114 },
  F4: { key: "F4", code: "F4", keyCode: 115 },
  F5: { key: "F5", code: "F5", keyCode: 116 },
  F12: { key: "F12", code: "F12", keyCode: 123 },
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  win: "Meta",
  // "Mod" = Cmd on macOS, Ctrl elsewhere, so prompts can say Mod+A portably.
  mod: process.platform === "darwin" ? "Meta" : "Control",
};

export interface ParsedShortcut {
  modifiers: number;
  modifierKeys: KeyDescriptor[];
  key: KeyDescriptor;
}

/** Parse "Control+Shift+a", "Enter", "Mod+a", "x". */
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Empty key shortcut");
  let modifiers = 0;
  const modifierKeys: KeyDescriptor[] = [];
  const last = parts[parts.length - 1]!;
  for (const part of parts.slice(0, -1)) {
    const canon = MODIFIER_ALIASES[part.toLowerCase()] ?? part;
    const bit = MODIFIER_BITS[canon];
    if (bit === undefined) throw new Error(`Unknown modifier "${part}" in "${shortcut}"`);
    modifiers |= bit;
    modifierKeys.push(NAMED[canon]!);
  }
  const key = describeKey(last, (modifiers & MODIFIER_BITS.Shift!) !== 0);
  return { modifiers, modifierKeys, key };
}

export function describeKey(name: string, shift = false): KeyDescriptor {
  const named = NAMED[name] ?? NAMED[name.charAt(0).toUpperCase() + name.slice(1)];
  if (named) return named;
  if (name.length === 1) {
    const ch = shift ? name.toUpperCase() : name;
    const upper = name.toUpperCase();
    const isLetter = /^[a-z]$/i.test(name);
    const isDigit = /^[0-9]$/.test(name);
    // The physical key, as KeyboardEvent.code names it on a US keyboard ("Space", "Digit1" for "!").
    const punct = US_PUNCTUATION_CODE[ch];
    const shifted = isLetter ? ch !== ch.toLowerCase() : !!punct && punct[1] !== ch;
    return {
      key: ch,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : (punct?.[0] ?? ""),
      // A character's char code is not its virtual key code: "(" is 40, which Chrome reads as ArrowDown.
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : (US_PUNCTUATION_VK[ch] ?? 0),
      text: ch,
      ...(shifted ? { shift: true, unshifted: isLetter ? ch.toLowerCase() : punct![1] } : {}),
    };
  }
  throw new Error(`Unknown key "${name}"`);
}

/** The US-layout key (KeyboardEvent.code) for each punctuation character, and that key's unshifted character. */
const US_PUNCTUATION_CODE: Record<string, [string, string]> = {
  " ": ["Space", " "], ")": ["Digit0", "0"], "!": ["Digit1", "1"], "@": ["Digit2", "2"], "#": ["Digit3", "3"], $: ["Digit4", "4"], "%": ["Digit5", "5"], "^": ["Digit6", "6"], "&": ["Digit7", "7"], "*": ["Digit8", "8"], "(": ["Digit9", "9"],
  ";": ["Semicolon", ";"], ":": ["Semicolon", ";"], "=": ["Equal", "="], "+": ["Equal", "="], ",": ["Comma", ","], "<": ["Comma", ","], "-": ["Minus", "-"], _: ["Minus", "-"], ".": ["Period", "."], ">": ["Period", "."],
  "/": ["Slash", "/"], "?": ["Slash", "/"], "`": ["Backquote", "`"], "~": ["Backquote", "`"], "[": ["BracketLeft", "["], "{": ["BracketLeft", "["], "\\": ["Backslash", "\\"], "|": ["Backslash", "\\"], "]": ["BracketRight", "]"], "}": ["BracketRight", "]"], "'": ["Quote", "'"], '"': ["Quote", "'"],
};

/** Windows virtual key codes of the US-layout keys that produce each punctuation character. */
const US_PUNCTUATION_VK: Record<string, number> = {
  " ": 32, ")": 48, "!": 49, "@": 50, "#": 51, $: 52, "%": 53, "^": 54, "&": 55, "*": 56, "(": 57,
  ";": 186, ":": 186, "=": 187, "+": 187, ",": 188, "<": 188, "-": 189, _: 189, ".": 190, ">": 190,
  "/": 191, "?": 191, "`": 192, "~": 192, "[": 219, "{": 219, "\\": 220, "|": 220, "]": 221, "}": 221, "'": 222, '"': 222,
};
