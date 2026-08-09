import test from "node:test";
import assert from "node:assert/strict";
import {
  BeeperApiClient,
  BeeperDiagnosticError,
  accountDiagnostic,
  type BeeperInfo,
  type FetchLike,
} from "../src/index.ts";
import type { BeeperAccount } from "../src/types.ts";

function info(remoteAccess = false): BeeperInfo {
  return {
    app: { name: "Beeper", version: "4.3.20", bundle_id: "com.automattic.beeper.desktop" },
    platform: { os: "darwin", arch: "arm64" },
    server: {
      status: "running",
      base_url: "http://127.0.0.1:23373",
      port: 23373,
      hostname: "127.0.0.1",
      remote_access: remoteAccess,
      mcp_enabled: true,
    },
    endpoints: {
      oauth: {
        authorization_endpoint: "http://127.0.0.1:23373/oauth/authorize",
        token_endpoint: "http://127.0.0.1:23373/oauth/token",
        introspection_endpoint: "http://127.0.0.1:23373/oauth/introspect",
        userinfo_endpoint: "http://127.0.0.1:23373/oauth/userinfo",
        revocation_endpoint: "http://127.0.0.1:23373/oauth/revoke",
        registration_endpoint: "http://127.0.0.1:23373/oauth/register",
      },
      spec: "http://127.0.0.1:23373/v1/spec",
      mcp: "http://127.0.0.1:23373/v0/mcp",
      ws_events: "http://127.0.0.1:23373/v1/ws",
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sequence(...responses: Response[]): FetchLike {
  let index = 0;
  return async () => {
    const current = responses[index++];
    if (!current) throw new Error(`unexpected fetch ${index}`);
    return current;
  };
}

function connectionRefused(): Error {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:23373"), { code: "ECONNREFUSED" });
  return Object.assign(new Error("fetch failed"), { cause });
}

const account: BeeperAccount = {
  accountID: "signal-account",
  bridge: { id: "signal", type: "signal", provider: "local" },
  network: "Signal",
  user: { id: "self", username: "me", fullName: "Me", isSelf: true },
  status: "connection_required",
  statusText: "Sign in required",
};

test("missing token has a distinct actionable diagnostic", async () => {
  const client = new BeeperApiClient({
    fetchImpl: async () => {
      throw new Error("fetch must not run without a token");
    },
  });
  await assert.rejects(
    client.listAccounts(),
    (error: unknown) => {
      assert.ok(error instanceof BeeperDiagnosticError);
      assert.equal(error.code, "BEEPER_TOKEN_MISSING");
      assert.match(error.message, /beeper-setup/);
      return true;
    },
  );
});

test("Beeper not running has a distinct actionable diagnostic", async () => {
  const client = new BeeperApiClient({
    token: "test-token",
    fetchImpl: async () => {
      throw connectionRefused();
    },
    processProbe: async () => false,
  });
  await assert.rejects(
    client.listAccounts(),
    (error: unknown) => {
      assert.ok(error instanceof BeeperDiagnosticError);
      assert.equal(error.code, "BEEPER_NOT_RUNNING");
      assert.match(error.message, /Open Beeper Desktop/);
      return true;
    },
  );
});

test("a running desktop with a closed API port has its own diagnostic", async () => {
  const client = new BeeperApiClient({
    token: "test-token",
    fetchImpl: async () => {
      throw connectionRefused();
    },
    processProbe: async () => true,
  });
  await assert.rejects(
    client.listAccounts(),
    (error: unknown) => {
      assert.ok(error instanceof BeeperDiagnosticError);
      assert.equal(error.code, "BEEPER_PORT_CLOSED");
      assert.match(error.message, /port 23373 is closed/);
      return true;
    },
  );
});

test("a rejected bearer token has its own diagnostic", async () => {
  const client = new BeeperApiClient({
    token: "test-token",
    fetchImpl: sequence(response(info()), response({ message: "Unauthorized", code: "unauthorized" }, 401)),
    processProbe: async () => true,
  });
  await assert.rejects(
    client.listAccounts(),
    (error: unknown) => {
      assert.ok(error instanceof BeeperDiagnosticError);
      assert.equal(error.code, "BEEPER_TOKEN_REVOKED");
      assert.match(error.message, /rejected or revoked/);
      return true;
    },
  );
});

test("a logged-out network account has a distinct actionable diagnostic", () => {
  const diagnostic = accountDiagnostic(account);
  assert.ok(diagnostic);
  assert.equal(diagnostic.code, "BEEPER_ACCOUNT_LOGGED_OUT");
  assert.match(diagnostic.message, /reconnect/);
});

test("remote access is refused rather than enabled or used", async () => {
  const client = new BeeperApiClient({
    token: "test-token",
    fetchImpl: sequence(response(info(true))),
  });
  await assert.rejects(
    client.getInfo(),
    (error: unknown) => {
      assert.ok(error instanceof BeeperDiagnosticError);
      assert.equal(error.code, "BEEPER_REMOTE_ACCESS_ENABLED");
      return true;
    },
  );
});
