import { tmpdir } from "node:os";

export const SOCKET_ENV = "PI_CODRIVE_SOCKET";
export const NONCE_ENV = "PI_CODRIVE_NONCE";
export const SESSION_ID_ENV = "PI_CODRIVE_SESSION_ID";
export const CHILD_ID_ENV = "PI_CODRIVE_CHILD_ID";
const CREDENTIAL_KEYS = [SOCKET_ENV, NONCE_ENV, SESSION_ID_ENV, CHILD_ID_ENV] as const;
const LEGACY_KEYS = [
  "PI_SPAWN_NOTIFY_FILE",
  "PI_SPAWN_AGENT_REPORT_FILE",
] as const;

/**
 * Capture child IPC credentials and identity once and scrub them from the
 * environment so nested processes cannot inherit the parent's socket/nonce
 * (or impersonate this child's identity) and forge reports.
 */
export function captureChildIpcEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const captured: NodeJS.ProcessEnv = {};
  for (const key of CREDENTIAL_KEYS) {
    const value = env[key];
    if (value) captured[key] = value;
    delete env[key];
  }
  for (const key of LEGACY_KEYS) delete env[key];
  return captured;
}

/**
 * Detect whether the current environment indicates this process is a codrive child.
 */
export function isCodriveChildEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    env[SOCKET_ENV] ||
      env[NONCE_ENV] ||
      env.PI_SPAWN_NOTIFY_FILE ||
      env.PI_SPAWN_AGENT_REPORT_FILE,
  );
}

/**
 * Derive the runtime root directory using XDG conventions (XDG_RUNTIME_DIR or tmpdir fallback),
 * consistent with the harness's socketBase pattern.
 */
export function defaultRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || tmpdir();
  return `${base}/pi-codrive-runtime`;
}
