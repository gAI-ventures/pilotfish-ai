// Reading files the agent downloaded or a PDF it has open, as plain text for the model.
// PDFs go through pdf.js (Apache-2.0): Chrome's viewer exposes no text in the DOM.

import { readFile, stat } from "node:fs/promises";

/** Text of a PDF, page by page, capped at `maxChars`. */
export async function pdfText(data: Uint8Array, maxChars = 30_000): Promise<{ pages: number; text: string; truncated: boolean }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const parts: string[] = [];
  let chars = 0;
  let truncated = false;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join("").replace(/[ \t]+\n/g, "\n").trim();
    parts.push(`--- page ${i} ---\n${line}`);
    chars += line.length + 16;
    if (chars > maxChars) {
      truncated = i < doc.numPages;
      break;
    }
  }
  const pages = doc.numPages;
  await doc.destroy();
  const text = parts.join("\n");
  return { pages, text: text.length > maxChars ? text.slice(0, maxChars) : text, truncated: truncated || text.length > maxChars };
}

/** A downloaded file as text: PDFs extracted, text formats read as UTF-8, other binaries described. */
export async function fileText(path: string, name: string, maxChars = 30_000): Promise<string> {
  const size = (await stat(path)).size;
  const bytes = await readFile(path);
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    const r = await pdfText(new Uint8Array(bytes), maxChars);
    return `${name}: PDF, ${r.pages} page(s)${r.truncated ? ` (text truncated at ${maxChars} chars)` : ""}\n${r.text}`;
  }
  // A NUL byte in the first 4 KB: not text.
  if (bytes.subarray(0, 4096).includes(0)) return `${name}: binary file (${size} bytes); its contents cannot be shown as text.`;
  const text = bytes.toString("utf8");
  return `${name}: ${size} bytes${text.length > maxChars ? ` (truncated at ${maxChars} chars)` : ""}\n${text.slice(0, maxChars)}`;
}
