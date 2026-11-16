// Transport abstraction for the Chrome DevTools Protocol.
//
// Two transports are supported:
//   - PipeTransport: `--remote-debugging-pipe` (fd 3 = Chrome stdin, fd 4 = Chrome stdout).
//     Messages are NUL-delimited JSON. No TCP port is opened, so nothing on the
//     host can attach to the browser except us. Preferred for local launches.
//   - WebSocketTransport: `ws://.../devtools/browser/<id>`. Used for remote
//     browsers (hosted sessions, `--remote-debugging-port`) and for a host
//     that must hand a WebSocket URL to external clients.

import { WebSocket } from "ws";
import type { Readable, Writable } from "node:stream";

export interface Transport {
  send(message: string): void;
  onMessage: ((message: string) => void) | null;
  onClose: ((reason?: string) => void) | null;
  close(): void;
  readonly closed: boolean;
}

export class PipeTransport implements Transport {
  onMessage: ((message: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  closed = false;
  private buffer: Buffer[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly writable: Writable,
    private readonly readable: Readable,
  ) {
    readable.on("data", (chunk: Buffer) => this.onData(chunk));
    readable.once("close", () => this.handleClose("pipe closed"));
    readable.once("error", (err: Error) => this.handleClose(`pipe error: ${err.message}`));
    writable.once("error", (err: Error) => this.handleClose(`pipe error: ${err.message}`));
  }

  send(message: string): void {
    if (this.closed) throw new Error("PipeTransport is closed");
    this.writable.write(message + "\0");
  }

  close(): void {
    this.handleClose("closed by client");
  }

  private onData(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const nul = chunk.indexOf(0, start);
      if (nul === -1) {
        const rest = chunk.subarray(start);
        if (rest.length) {
          this.buffer.push(rest);
          this.pendingBytes += rest.length;
        }
        return;
      }
      const piece = chunk.subarray(start, nul);
      let message: string;
      if (this.buffer.length) {
        this.buffer.push(piece);
        message = Buffer.concat(this.buffer, this.pendingBytes + piece.length).toString("utf8");
        this.buffer = [];
        this.pendingBytes = 0;
      } else {
        message = piece.toString("utf8");
      }
      this.onMessage?.(message);
      start = nul + 1;
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}

export class WebSocketTransport implements Transport {
  onMessage: ((message: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.onMessage?.(data.toString()));
    ws.once("close", (code, reason) => this.handleClose(`ws closed ${code} ${reason.toString()}`));
    ws.once("error", (err) => this.handleClose(`ws error: ${err.message}`));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP WebSocket connect timed out after ${timeoutMs}ms: ${url}`));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new WebSocketTransport(ws));
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(message: string): void {
    if (this.closed) throw new Error("WebSocketTransport is closed");
    this.ws.send(message);
  }

  close(): void {
    this.ws.close();
    this.handleClose("closed by client");
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}
