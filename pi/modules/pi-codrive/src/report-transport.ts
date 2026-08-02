import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { platform } from "node:os";
import { RuntimeStore, type CodriveReport } from "./runtime-store.ts";

const IPC_VERSION = 1;
const MAX_FRAME_BYTES = 256 * 1024;

/**
 * Envelope kinds carried over the authenticated IPC channel. Only "report"
 * (and a legacy envelope with no kind at all) is terminal and persisted to
 * the store. The other kinds update the parent's in-memory and ledger state
 * without inflating the on-disk report history.
 */
export type EnvelopeKind = "announce" | "heartbeat" | "interrupt" | "report" | "farewell";

export interface AnnouncePayload {
  piSessionFile?: string;
  piSessionId?: string;
  paneId?: string;
  cwd?: string;
  model?: string;
}

export interface InterruptEvidence {
  /** Last provider HTTP status observed before the stream tore down. */
  providerStatus?: number;
  /** Retry-After header value, when the provider supplied one. */
  retryAfter?: string;
  /** True when the HTTP evidence indicates a retryable failure (429 or 5xx). */
  transient: boolean;
  /** Human readable reason string surfaced when an escalation fires. */
  reason: string;
}

export interface FarewellPayload {
  reason: string;
}

/**
 * The normalized message the parent's onEnvelope handler receives. Every
 * envelope carries a kind, a dedupe eventId, and the child identity. A
 * terminal envelope additionally carries the CodriveReport.
 */
export interface CodriveEnvelope {
  version: 1;
  kind: EnvelopeKind;
  eventId: string;
  sessionId: string;
  childId: string;
  paneId?: string;
  timestamp: string;
  report?: CodriveReport;
  announce?: AnnouncePayload;
  interrupt?: InterruptEvidence;
  farewell?: FarewellPayload;
  assistantText?: string;
}

/**
 * The wire object framed over the socket. A legacy sender emits only
 * { version, nonce, report } with no kind; that MUST still be accepted as a
 * terminal report (protocol v1). New senders add a kind and the top-level
 * identity/eventId fields.
 */
interface WireMessage {
  version: 1;
  nonce: string;
  kind?: EnvelopeKind;
  eventId?: string;
  sessionId?: string;
  childId?: string;
  paneId?: string;
  timestamp?: string;
  report?: CodriveReport;
  announce?: AnnouncePayload;
  interrupt?: InterruptEvidence;
  farewell?: FarewellPayload;
  assistantText?: string;
}

export interface ReportServerHandle {
  socketPath: string;
  nonce: string;
  close(): Promise<void>;
}

export interface ReportServerOptions {
  runtimeRoot: string;
  sessionId: string;
  store: RuntimeStore;
  /**
   * Called synchronously, once per distinct eventId, immediately after a
   * validated TERMINAL report has been durably persisted to the store. This
   * preserves the original terminal-only contract for existing hosts.
   * Replayed/duplicate eventIds do not re-invoke this callback.
   */
  onReport?: (report: CodriveReport) => void;
  /**
   * Called synchronously, once per distinct eventId, for EVERY validated
   * envelope kind (announce/heartbeat/interrupt/report/farewell), after any
   * terminal persistence. This is the single seam the supervisor consumes to
   * drive the per-child lifecycle state machine.
   */
  onEnvelope?: (envelope: CodriveEnvelope) => void;
}

function encodeFrame(message: WireMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function frameState(frame: Buffer, maxBytes: number): "incomplete" | "exact" {
  if (frame.length < 4) return "incomplete";
  const size = frame.readUInt32BE(0);
  if (size > maxBytes) throw new Error("oversized frame");
  const expected = size + 4;
  if (frame.length < expected) return "incomplete";
  if (frame.length > expected)
    throw new Error("overlong or multiple frame payload");
  return "exact";
}

function decodeWire(frame: Buffer, maxBytes: number): WireMessage {
  if (frameState(frame, maxBytes) === "incomplete")
    throw new Error("incomplete frame length");
  const message = JSON.parse(frame.subarray(4).toString()) as WireMessage;
  if (message.version !== IPC_VERSION || typeof message.nonce !== "string")
    throw new Error("invalid IPC message");
  return message;
}

/**
 * Turn a validated wire object into a normalized envelope. An absent kind is
 * treated as a terminal report (protocol v1 back-compat). Throws when the
 * required fields for the resolved kind are missing so a malformed frame is
 * rejected before any state mutation.
 */
function normalizeEnvelope(message: WireMessage): CodriveEnvelope {
  const kind: EnvelopeKind = message.kind ?? "report";
  if (kind === "report") {
    const report = message.report;
    if (!report || typeof report !== "object")
      throw new Error("terminal envelope has no report");
    return {
      version: 1,
      kind: "report",
      eventId: report.eventId,
      sessionId: report.sessionId,
      childId: report.childId,
      paneId: report.paneId,
      timestamp: report.timestamp,
      report,
      assistantText: report.assistantText,
    };
  }
  if (
    typeof message.eventId !== "string" ||
    typeof message.sessionId !== "string" ||
    typeof message.childId !== "string"
  )
    throw new Error("non-terminal envelope missing identity fields");
  return {
    version: 1,
    kind,
    eventId: message.eventId,
    sessionId: message.sessionId,
    childId: message.childId,
    paneId: message.paneId,
    timestamp: message.timestamp ?? new Date().toISOString(),
    announce: message.announce,
    interrupt: message.interrupt,
    farewell: message.farewell,
    assistantText: message.assistantText,
  };
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function socketPathLimit(platformName: NodeJS.Platform): number {
  if (platformName === "darwin") return 103;
  if (platformName === "linux") return 107;
  return 103;
}

function chooseSocketDirectory(
  base: string,
  platformName: NodeJS.Platform,
  token: string,
): string {
  const name = `pcd-${process.pid}-${token.slice(0, 8)}`;
  const limit = socketPathLimit(platformName);
  const preferred = join(base, name);
  if (Buffer.byteLength(join(preferred, "s")) <= limit) return preferred;
  const fallback = join("/tmp", name);
  if (Buffer.byteLength(join(fallback, "s")) <= limit) return fallback;
  throw new Error(
    "Unable to create a Unix socket path within the platform limit",
  );
}

export const ReportServer = {
  async start(options: ReportServerOptions): Promise<ReportServerHandle> {
    const { runtimeRoot, sessionId, store } = options;
    const token = randomBytes(18).toString("hex");
    const directory = chooseSocketDirectory(runtimeRoot, platform(), token);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("unsafe IPC directory");

    const socketPath = join(directory, "s");
    const nonce = randomBytes(32).toString("base64url");
    const seen = new Set<string>();

    const server = createServer((client) =>
      receive(client, MAX_FRAME_BYTES, nonce, seen, sessionId, store, options),
    );

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);

    return {
      socketPath,
      nonce,
      close: async () => {
        await closeServer(server);
        rmSync(directory, { recursive: true, force: true });
      },
    };
  },
};

function receive(
  client: Socket,
  maxBytes: number,
  nonce: string,
  seen: Set<string>,
  sessionId: string,
  store: RuntimeStore,
  options: ReportServerOptions,
): void {
  let data = Buffer.alloc(0);
  client.setTimeout(5000, () => client.destroy());
  client.on("data", (chunk) => {
    data = Buffer.concat([data, chunk]);
    try {
      if (frameState(data, maxBytes) === "incomplete") return;
      const wire = decodeWire(data, maxBytes);
      // Authenticate before parsing payloads or mutating any state. A wrong
      // nonce is rejected here, before dedupe, persistence, or callbacks.
      if (!timingSafeTextEqual(wire.nonce, nonce)) {
        client.end("authentication failed");
        return;
      }
      const envelope = normalizeEnvelope(wire);
      if (envelope.sessionId !== sessionId) {
        throw new Error("envelope belongs to another session");
      }
      if (!seen.has(envelope.eventId)) {
        if (envelope.kind === "report" && envelope.report) {
          store.appendReport(envelope.report);
        }
        seen.add(envelope.eventId);
        if (envelope.kind === "report" && envelope.report) {
          options.onReport?.(envelope.report);
        }
        options.onEnvelope?.(envelope);
      }
      client.end("ok");
    } catch {
      client.destroy();
    }
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function writeFrame(
  socketPath: string,
  message: WireMessage,
): Promise<void> {
  const frame = encodeFrame(message);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("timeout")), 5000);
    socket.once("connect", () => socket.write(frame));
    socket.once("data", (response) => {
      clearTimeout(timer);
      const text = response.toString();
      if (text === "ok") finish();
      else finish(new Error(text));
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      finish(err);
    });
  });
}

/**
 * Send a terminal report using the legacy wire shape (no kind). This keeps
 * the protocol v1 frame intact and exercises the legacy acceptance path.
 */
export async function sendReport(
  socketPath: string,
  nonce: string,
  report: CodriveReport,
): Promise<void> {
  return writeFrame(socketPath, { version: 1, nonce, report });
}

export interface OutgoingEnvelope {
  kind: EnvelopeKind;
  eventId: string;
  sessionId: string;
  childId: string;
  paneId?: string;
  timestamp?: string;
  report?: CodriveReport;
  announce?: AnnouncePayload;
  interrupt?: InterruptEvidence;
  farewell?: FarewellPayload;
  assistantText?: string;
}

/**
 * Send any envelope kind over the authenticated channel. A terminal "report"
 * envelope carries the CodriveReport; other kinds carry their own payloads.
 */
export async function sendEnvelope(
  socketPath: string,
  nonce: string,
  envelope: OutgoingEnvelope,
): Promise<void> {
  return writeFrame(socketPath, {
    version: 1,
    nonce,
    kind: envelope.kind,
    eventId: envelope.eventId,
    sessionId: envelope.sessionId,
    childId: envelope.childId,
    paneId: envelope.paneId,
    timestamp: envelope.timestamp ?? new Date().toISOString(),
    report: envelope.report,
    announce: envelope.announce,
    interrupt: envelope.interrupt,
    farewell: envelope.farewell,
    assistantText: envelope.assistantText,
  });
}
