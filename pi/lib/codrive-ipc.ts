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
import { socketBase, type CodriveConfig } from "./codrive-config.ts";
import {
  isSpawnReportRecord,
  type SpawnReportRecord,
} from "./codrive-state.ts";

export const IPC_VERSION = 1;
export const SOCKET_ENV = "PI_CODRIVE_SOCKET";
export const NONCE_ENV = "PI_CODRIVE_NONCE";
export interface IpcMessage {
  version: 1;
  nonce: string;
  report: SpawnReportRecord;
}
export function encodeFrame(message: IpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}
export function frameState(
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
export function decodeFrame(frame: Buffer, maxBytes: number): IpcMessage {
  if (frameState(frame, maxBytes) === "incomplete")
    throw new Error("incomplete frame length");
  const message = JSON.parse(
    frame.subarray(4).toString(),
  ) as Partial<IpcMessage>;
  if (
    message.version !== IPC_VERSION ||
    typeof message.nonce !== "string" ||
    !isSpawnReportRecord(message.report)
  )
    throw new Error("invalid IPC message");
  return message as IpcMessage;
}
export interface IpcServer {
  path: string;
  nonce: string;
  close(): Promise<void>;
}
export function socketPathLimit(platformName: NodeJS.Platform): number {
  if (platformName === "darwin") return 103;
  if (platformName === "linux") return 107;
  throw new Error(`Unsupported platform: ${platformName}`);
}
export function chooseSocketDirectory(
  preferredBase: string,
  platformName: NodeJS.Platform,
  pid: number,
  token: string,
): string {
  const name = `pcd-${pid}-${token.slice(0, 8)}`;
  const limit = socketPathLimit(platformName);
  const preferred = join(preferredBase, name);
  if (Buffer.byteLength(join(preferred, "s")) <= limit) return preferred;
  const fallback = join("/tmp", name);
  if (Buffer.byteLength(join(fallback, "s")) <= limit) return fallback;
  throw new Error(
    "Unable to create a Unix socket path within the platform limit",
  );
}
export async function startIpcServer(
  config: CodriveConfig,
  onReport: (report: SpawnReportRecord) => boolean,
): Promise<IpcServer> {
  const token = randomBytes(18).toString("hex");
  const directory = chooseSocketDirectory(
    socketBase(),
    platform(),
    process.pid,
    token,
  );
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("unsafe IPC directory");
  const socketPath = join(directory, "s");
  const nonce = randomBytes(32).toString("base64url");
  const seen = new Set<string>();
  const server = createServer((client) =>
    receive(
      client,
      config.notifications.maxMessageBytes,
      nonce,
      seen,
      onReport,
    ),
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
    path: socketPath,
    nonce,
    close: async () => {
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function receive(
  client: Socket,
  maxBytes: number,
  nonce: string,
  seen: Set<string>,
  onReport: (report: SpawnReportRecord) => boolean,
): void {
  let data = Buffer.alloc(0);
  client.setTimeout(5000, () => client.destroy());
  client.on("data", (chunk) => {
    data = Buffer.concat([data, chunk]);
    try {
      if (frameState(data, maxBytes) === "incomplete") return;
      const message = decodeFrame(data, maxBytes);
      if (!timingSafeTextEqual(message.nonce, nonce))
        throw new Error("authentication failed");
      if (!seen.has(message.report.eventId)) {
        if (!onReport(message.report)) {
          client.destroy();
          return;
        }
        seen.add(message.report.eventId);
      }
      client.end("ok");
    } catch {
      client.destroy();
    }
  });
}
function timingSafeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
export async function sendReport(
  report: SpawnReportRecord,
  config: CodriveConfig,
  env = process.env,
): Promise<boolean> {
  const socketPath = env[SOCKET_ENV];
  const nonce = env[NONCE_ENV];
  if (!socketPath || !nonce) return false;
  const frame = encodeFrame({ version: 1, nonce, report });
  if (frame.length > config.notifications.maxMessageBytes + 4) return false;
  for (let attempt = 0; attempt <= config.notifications.retries; attempt++) {
    if (
      await connectOnce(
        socketPath,
        frame,
        config.notifications.connectTimeoutMs,
      )
    )
      return true;
    if (attempt < config.notifications.retries)
      await new Promise((resolve) =>
        setTimeout(resolve, config.notifications.retryMs * (attempt + 1)),
      );
  }
  return false;
}
function connectOnce(
  socketPath: string,
  frame: Buffer,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => socket.write(frame));
    socket.once("data", (data) => finish(data.toString() === "ok"));
    socket.once("error", () => finish(false));
  });
}
