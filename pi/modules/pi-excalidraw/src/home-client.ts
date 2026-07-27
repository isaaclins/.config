import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Transport to the home Excalidraw agent bridge.
 *
 * The bridge (excalidraw-agent.service on the homeserver) listens on
 * 127.0.0.1:8571 only; Caddy exposes just the preview/edit/board routes, not
 * the /api/* control surface. Disclaw can talk to it directly because it runs
 * on the same host. From the laptop the only supported path is SSH, so every
 * call is a short `curl` invocation on the remote side, multiplexed over a
 * persistent SSH control socket so repeated calls cost ~100ms, not a full
 * handshake each.
 */

export interface HomeClientConfig {
  sshTarget: string;
  agentUrl: string;
  agentName: string;
  agentLabel: string;
  defaultOwner: string;
  timeoutMs: number;
  controlPath: string;
}

export interface RoomSummary {
  id: string;
  title: string;
  elementCount: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
  publicReadOnlyUrl: string;
  authenticatedEditUrl: string;
  directRoomUrl?: string;
  roomId?: string;
}

export interface AgentResponse {
  ok: boolean;
  room?: RoomSummary;
  rooms?: RoomSummary[];
  elements?: unknown[];
  files?: Record<string, unknown>;
  appState?: Record<string, unknown>;
  error?: string;
}

const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HomeClientConfig {
  const controlDir = env.XDG_RUNTIME_DIR || tmpdir();
  return {
    sshTarget: env.PI_EXCALIDRAW_SSH_TARGET || "isaaclins@homeserver",
    agentUrl: (env.PI_EXCALIDRAW_AGENT_URL || "http://127.0.0.1:8571").replace(/\/+$/, ""),
    agentName: env.PI_EXCALIDRAW_AGENT_NAME || "pi",
    agentLabel: env.PI_EXCALIDRAW_AGENT_LABEL || "Pi",
    defaultOwner: env.PI_EXCALIDRAW_DEFAULT_OWNER ?? "isaaclins",
    timeoutMs: Number(env.PI_EXCALIDRAW_TIMEOUT_MS || 45_000),
    controlPath: env.PI_EXCALIDRAW_SSH_CONTROL_PATH || join(controlDir, "pi-excalidraw-%r@%h:%p"),
  };
}

export function assertRoomId(roomId: string): string {
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw new Error(`Invalid Excalidraw room id: ${JSON.stringify(roomId)}`);
  }
  return roomId;
}

function remoteCurl(config: HomeClientConfig, method: string, path: string, hasBody: boolean): string {
  const url = `${config.agentUrl}${path}`;
  const parts = ["curl", "-sS", "--max-time", "30", "-X", method];
  if (hasBody) parts.push("-H", "'Content-Type: application/json'", "--data-binary", "@-");
  parts.push(`'${url}'`);
  return parts.join(" ");
}

function friendlyError(stderr: string, raw: string): string {
  if (/Connection refused/i.test(raw) || /Connection refused/i.test(stderr)) {
    return "Home Excalidraw agent is not answering on 127.0.0.1:8571. Check `systemctl --user status excalidraw-agent` on the homeserver.";
  }
  if (/Could not resolve hostname|Host key verification|Permission denied|Connection timed out/i.test(stderr)) {
    return `SSH to the homeserver failed: ${stderr.trim()}`;
  }
  return stderr.trim() || raw.trim() || "Unknown Excalidraw agent failure";
}

export async function agentRequest(
  config: HomeClientConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<AgentResponse> {
  const hasBody = body !== undefined;
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${config.controlPath}`,
    "-o", "ControlPersist=300",
    config.sshTarget,
    remoteCurl(config, method, path, hasBody),
  ];

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: process.env.HOME || homedir() } });

  const timer = setTimeout(() => child.kill("SIGKILL"), config.timeoutMs);
  const onAbort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  if (hasBody) {
    child.stdin.write(JSON.stringify(body));
  }
  child.stdin.end();

  const code: number = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });

  const raw = Buffer.concat(stdout).toString("utf8");
  const errText = Buffer.concat(stderr).toString("utf8");

  if (code !== 0 && !raw.trim()) {
    throw new Error(friendlyError(errText, raw));
  }

  let json: AgentResponse;
  try {
    json = raw.trim() ? (JSON.parse(raw) as AgentResponse) : { ok: false, error: "empty response" };
  } catch {
    throw new Error(`Excalidraw agent returned non-JSON response: ${raw.slice(0, 200)}`);
  }

  if (json.ok === false) {
    throw new Error(json.error || `Excalidraw agent request failed (exit ${code})`);
  }
  return json;
}

/** Ownership fields the bridge uses to file a board in the board library. */
export function ownershipFields(config: HomeClientConfig, forUser?: string): Record<string, string> {
  const owner = (forUser ?? config.defaultOwner).trim();
  const fields: Record<string, string> = { agent: config.agentName, agentLabel: config.agentLabel };
  if (owner) fields.forUser = owner;
  return fields;
}

/** Compact per-file metadata, so scene dumps never carry base64 image payloads. */
export function fileMetadata(files: Record<string, any> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(files || {}).map(([id, file]) => [
      id,
      {
        id: file?.id || id,
        mimeType: file?.mimeType || "",
        created: file?.created ?? null,
        dataUrlBytes: typeof file?.dataURL === "string" ? file.dataURL.length : 0,
      },
    ]),
  );
}
