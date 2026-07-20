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
   * validated report has been durably persisted to the store. This is the
   * only hook that lets a host (an extension.ts) learn about a completed
   * report as it arrives, rather than only on the next manual read of the
   * store. Replayed/duplicate eventIds do not re-invoke this callback.
   */
  onReport?: (report: CodriveReport) => void;
}

interface IpcMessage {
  version: 1;
  nonce: string;
  report: CodriveReport;
}

function encodeFrame(message: IpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function frameState(
  frame: Buffer,
  maxBytes: number,
): "incomplete" | "exact" {
  if (frame.length < 4) return "incomplete";
  const size = frame.readUInt32BE(0);
  if (size > maxBytes) throw new Error("oversized frame");
  const expected = size + 4;
  if (frame.length < expected) return "incomplete";
  if (frame.length > expected)
    throw new Error("overlong or multiple frame payload");
  return "exact";
}

function decodeFrame(frame: Buffer, maxBytes: number): IpcMessage {
  if (frameState(frame, maxBytes) === "incomplete")
    throw new Error("incomplete frame length");
  const message = JSON.parse(frame.subarray(4).toString()) as IpcMessage;
  if (
    message.version !== IPC_VERSION ||
    typeof message.nonce !== "string" ||
    !message.report ||
    typeof message.report !== "object"
  )
    throw new Error("invalid IPC message");
  return message;
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
      receive(client, MAX_FRAME_BYTES, nonce, seen, sessionId, store, options.onReport),
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
  onReport: ((report: CodriveReport) => void) | undefined,
): void {
  let data = Buffer.alloc(0);
  client.setTimeout(5000, () => client.destroy());
  client.on("data", (chunk) => {
    data = Buffer.concat([data, chunk]);
    try {
      if (frameState(data, maxBytes) === "incomplete") return;
      const message = decodeFrame(data, maxBytes);
      if (!timingSafeTextEqual(message.nonce, nonce)) {
        client.end("authentication failed");
        return;
      }
      if (!seen.has(message.report.eventId)) {
        store.appendReport(message.report);
        seen.add(message.report.eventId);
        onReport?.(message.report);
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

export async function sendReport(
  socketPath: string,
  nonce: string,
  report: CodriveReport,
): Promise<void> {
  const frame = encodeFrame({ version: 1, nonce, report });
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
