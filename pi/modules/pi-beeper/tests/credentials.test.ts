import test from "node:test";
import assert from "node:assert/strict";
import { hasRejectedTokenEnvironment, readTokenOnce, type TokenStore } from "../src/index.ts";

test("R6 rejects token environment variables without reading the store", () => {
  let readCount = 0;
  const store: TokenStore = {
    read: () => {
      readCount += 1;
      return "synthetic-keychain-token";
    },
    write: () => {},
  };
  assert.equal(hasRejectedTokenEnvironment({ BEEPER_TOKEN: "anything" }), true);
  const state = readTokenOnce(store, { BEEPER_TOKEN: "anything" });
  assert.equal(state.status, "environment-rejected");
  assert.equal(state.token, undefined);
  assert.equal(readCount, 0);
});

test("R6 reads a keychain token once and reports only availability", () => {
  let readCount = 0;
  const store: TokenStore = {
    read: () => {
      readCount += 1;
      return "synthetic-keychain-token";
    },
    write: () => {},
  };
  const state = readTokenOnce(store, {});
  assert.equal(state.status, "available");
  assert.equal(state.token, "synthetic-keychain-token");
  assert.equal(readCount, 1);
});
