import { tmpdir } from "node:os";

export const SOCKET_ENV = "PI_CODRIVE_SOCKET";
export const NONCE_ENV = "PI_CODRIVE_NONCE";
export const SESSION_ID_ENV = "PI_CODRIVE_SESSION_ID";
export const CHILD_ID_ENV = "PI_CODRIVE_CHILD_ID";
/** Non-secret process marker for sibling extensions that must be read-only in children. */
export const CHILD_MARKER_ENV = "PI_CODRIVE_CHILD";
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
  if (captured[SOCKET_ENV] || captured[CHILD_ID_ENV]) env[CHILD_MARKER_ENV] = "1";
  return captured;
}

/**
 * Detect whether the current environment indicates this process is a codrive child.
 */
export function isCodriveChildEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    env[CHILD_MARKER_ENV] ||
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
