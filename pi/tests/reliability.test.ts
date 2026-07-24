import assert from "node:assert/strict";
import test from "node:test";
import { SessionPoller } from "../lib/usage-lifecycle.ts";

test("usage poller cleanup clears its interval and prevents duplicate pollers (shared by anthropic-usage.ts)", () => {
  let created = 0;
  let cleared = 0;
  const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;
  const poller = new SessionPoller(
    {
      setInterval: () => {
        created++;
        return timer;
      },
      clearInterval: () => {
        cleared++;
      },
    },
    1,
  );
  poller.start(() => {});
  poller.start(() => {});
  assert.equal(created, 1);
  assert.equal(poller.running, true);
  poller.stop();
  assert.equal(cleared, 1);
  assert.equal(poller.running, false);
});
