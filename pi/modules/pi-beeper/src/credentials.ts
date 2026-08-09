import { execFileSync } from "node:child_process";
import { platform } from "node:os";

export const KEYCHAIN_SERVICE = "pi-beeper";
export const KEYCHAIN_ACCOUNT = "beeper-access-token";
export const UNSUPPORTED_TOKEN_ENVIRONMENT_VARIABLES = ["BEEPER_TOKEN", "BEEPER_ACCESS_TOKEN"] as const;

export interface TokenStore {
  read(): string | undefined;
  write(token: string): void;
}

export interface TokenState {
  token?: string;
  status: "available" | "missing" | "environment-rejected";
}

/**
 * Keychain access is intentionally kept inside the extension process. The
 * command output is captured and never printed, returned, or passed to Pi.
 */
export function createMacKeychainTokenStore(): TokenStore {
  return {
    read(): string | undefined {
      if (platform() !== "darwin") return undefined;
      try {
        const token = execFileSync(
          "security",
          ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
        return token || undefined;
      } catch {
        return undefined;
      }
    },
    write(token: string): void {
      if (platform() !== "darwin") {
        throw new Error("Beeper token storage requires macOS Keychain");
      }
      execFileSync(
        "security",
        [
          "add-generic-password",
          "-U",
          "-s",
          KEYCHAIN_SERVICE,
          "-a",
          KEYCHAIN_ACCOUNT,
          "-w",
          token,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    },
  };
}

export function hasRejectedTokenEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return UNSUPPORTED_TOKEN_ENVIRONMENT_VARIABLES.some((name) =>
    Object.prototype.hasOwnProperty.call(env, name),
  );
}

/** Read exactly once at extension initialization, never from a tool argument. */
export function readTokenOnce(
  store: TokenStore = createMacKeychainTokenStore(),
  env: NodeJS.ProcessEnv = process.env,
): TokenState {
  if (hasRejectedTokenEnvironment(env)) {
    return { status: "environment-rejected" };
  }
  const token = store.read()?.trim();
  return token ? { status: "available", token } : { status: "missing" };
}

export function storeToken(store: TokenStore, token: string): void {
  const normalized = token.trim();
  if (!normalized) throw new Error("Cannot store an empty Beeper access token");
  store.write(normalized);
}
