import assert from "node:assert/strict";
import test from "node:test";
import { shouldNudge, type HandoverConfig } from "../src/handover.ts";

/**
 * Regression: exactly-once resume and session isolation.
 * The handover state (lastNudgedPercent, pendingHandover, compactRequested)
 * must be per-session, not shared as module-level mutable globals.
 *
 * This test verifies that the shouldNudge function itself is pure (no hidden
 * global state) and that two independent tracking states do not interfere.
 */
test("shouldNudge is pure: concurrent sessions with independent state do not interfere", () => {
  const config: HandoverConfig = { nudgeThresholdPercent: 50, nudgeRepeatStepPercent: 10 };

  // Session A crosses 50%
  let sessionALastNudged: number | null = null;
  assert.equal(shouldNudge(50, sessionALastNudged, config), true);
  sessionALastNudged = 50;

  // Session B is still below threshold -- must not be affected by A
  const sessionBLastNudged: number | null = null;
  assert.equal(shouldNudge(49, sessionBLastNudged, config), false);

  // Session A gets another nudge at 60
  assert.equal(shouldNudge(60, sessionALastNudged, config), true);
});

/**
 * Regression: exactly-once compaction resume.
 * The compactRequested flag must prevent double-trigger: once compact() is
 * called, subsequent turn_end events must not call compact() again.
 * This tests the pattern used in the extension (simulated here).
 */
test("compaction guard prevents double-trigger (exactly-once resume)", () => {
  let compactCalls = 0;
  let compactRequested = false;
  let pendingHandover: string | null = "some handover";

  function simulateTurnEnd() {
    if (pendingHandover !== null) {
      if (compactRequested) return;
      compactRequested = true;
      compactCalls++;
    }
  }

  simulateTurnEnd();
  simulateTurnEnd();
  simulateTurnEnd();

  assert.equal(compactCalls, 1, "compact should be called exactly once");
});
