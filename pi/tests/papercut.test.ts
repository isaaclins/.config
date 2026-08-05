import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_NOTE_BYTES,
  NOTE_TOOL,
  PAPERCUT_FILED_EVENT,
  REDACTED,
  buildNoteRecord,
  buildRecord,
  dailyFilePath,
  formatNotes,
  formatPapercutNote,
  isPapercut,
  isPapercutOwner,
  papercutRecords,
  pruneAuditDir,
  readAllRecords,
  redactInlineSecrets,
  retainRecords,
  writeRecord,
  type AuditRecord,
} from "../lib/tool-audit.ts";
import { runCli } from "../lib/tool-audit-cli.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

test("formatPapercutNote renders the repro shape in a fixed order and skips empty fields", () => {
  const note = formatPapercutNote({
    tried: "read the screenshot with the read tool",
    got: "unsupported image type: png",
    workaround: "converted it to JPEG with sips, then read it",
    repro: "read ~/Desktop/shot.png",
  });

  assert.equal(
    note,
    [
      "tried: read the screenshot with the read tool",
      "got: unsupported image type: png",
      "workaround: converted it to JPEG with sips, then read it",
      "repro: read ~/Desktop/shot.png",
    ].join("\n"),
  );
  assert.equal(note.includes("expected:"), false);
});

test("formatPapercutNote trims values and tolerates whitespace-only optional fields", () => {
  const note = formatPapercutNote({
    tried: "  ran the tests  ",
    got: "exit 1",
    workaround: "   ",
    expected: "exit 0",
  });

  assert.equal(note, ["tried: ran the tests", "got: exit 1", "expected: exit 0"].join("\n"));
});

test("buildNoteRecord produces a note-shaped record with its own call id", () => {
  const record = buildNoteRecord({
    sessionId: "session-abcdef123456",
    toolCallId: "call-42",
    cwd: "/Users/isaac/.config",
    fields: { tried: "read a png", got: "it failed" },
    owner: "config",
    refCallId: "deadbeef",
    suspects: ["pi/lib/tool-audit.ts"],
  });

  assert.equal(record.tool, NOTE_TOOL);
  assert.equal(record.outcome, "ok");
  assert.equal(record.owner, "config");
  assert.equal(record.refCallId, "deadbeef");
  assert.deepEqual(record.suspects, ["pi/lib/tool-audit.ts"]);
  assert.equal(record.note, "tried: read a png\ngot: it failed");
  assert.match(record.callId ?? "", /^[0-9a-f]{8}$/);
  assert.notEqual(record.callId, record.refCallId);
  assert.equal(isPapercut(record), true);
});

test("buildNoteRecord always assigns a call id even without a tool call id", () => {
  const first = buildNoteRecord({
    sessionId: "s",
    cwd: "/tmp",
    fields: { tried: "a", got: "b" },
  });
  const second = buildNoteRecord({
    sessionId: "s",
    cwd: "/tmp",
    fields: { tried: "a", got: "b" },
  });

  assert.match(first.callId ?? "", /^[0-9a-f]{8}$/);
  assert.notEqual(first.callId, second.callId);
});

test("an unattributed papercut keeps owner undefined rather than guessing", () => {
  const record = buildNoteRecord({
    sessionId: "s",
    cwd: "/tmp",
    fields: { tried: "a", got: "b" },
  });

  assert.equal(record.owner, undefined);
});

test("papercut notes reuse the shared redaction and truncation path", () => {
  const record = buildNoteRecord({
    sessionId: "s",
    cwd: "/tmp",
    fields: {
      tried: "called the api with api_key=sk-live-9999 and Bearer abc.def.ghi",
      got: "401",
    },
  });

  assert.equal(record.note?.includes("sk-live-9999"), false);
  assert.equal(record.note?.includes("abc.def.ghi"), false);
  assert.equal(record.note?.includes(REDACTED), true);

  const long = buildNoteRecord({
    sessionId: "s",
    cwd: "/tmp",
    fields: { tried: "x".repeat(MAX_NOTE_BYTES * 2), got: "y" },
  });
  assert.equal(Buffer.byteLength(long.note ?? "", "utf8") <= MAX_NOTE_BYTES + 32, true);
  assert.match(long.note ?? "", /\[\+\d+B\]$/);
});

test("redactInlineSecrets scrubs prose credentials but leaves ordinary text alone", () => {
  assert.equal(redactInlineSecrets("token: hunter2"), `token: ${REDACTED}`);
  assert.equal(redactInlineSecrets('"password":"pw"'), `"password":"${REDACTED}"`);
  assert.equal(redactInlineSecrets("Authorization: Bearer xyz123"), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactInlineSecrets("read failed on a png file"), "read failed on a png file");
});

test("redactInlineSecrets scrubs bare vendor credentials with no assignment", () => {
  // Assembled at runtime so no literal credential sits in the source for the
  // pre-commit secret scanner to flag.
  const bare = [
    `sk-ant-api03-${"a".repeat(20)}`,
    `gh${"p"}_${"b".repeat(30)}`,
    `github${"_pat_"}${"c".repeat(24)}`,
    `xox${"b"}-1234567890-${"d".repeat(12)}`,
    `AK${"IA"}${"E".repeat(16)}`,
    `AI${"za"}${"f".repeat(35)}`,
  ];
  for (const credential of bare) {
    const scrubbed = redactInlineSecrets(`got: 401 rejecting ${credential} on retry`);
    assert.equal(scrubbed.includes(credential), false, credential);
    assert.equal(scrubbed.includes(REDACTED), true, credential);
  }
});

test("redactInlineSecrets leaves prose that merely looks credential-shaped", () => {
  const innocuous = "skipped sk-test and gh_ prefixes, AKIA is short";
  assert.equal(redactInlineSecrets(innocuous), innocuous);
});

test("no field of a stored note keeps a credential in plaintext", () => {
  // A note is persisted three times over: args, the preview derived from the
  // result, and note. Redacting only one of them is the leak this guards.
  const record = buildNoteRecord({
    sessionId: "s1",
    toolCallId: "leak-probe",
    cwd: "/repo",
    fields: {
      tried: "curl the api with token=hunter2",
      got: "401 even though token=hunter2 was set",
      workaround: "exported API_KEY=hunter2 instead",
      expected: "a 200",
      repro: "curl -H 'Authorization: Bearer hunter2' localhost",
    },
    suspects: ["scripts/deploy.sh?token=hunter2"],
  });

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("hunter2"), false, serialized);
  assert.equal(serialized.includes(REDACTED), true);
});

test("isPapercutOwner accepts only the four known owners", () => {
  for (const owner of ["config", "pi", "model", "env"]) {
    assert.equal(isPapercutOwner(owner), true);
  }
  assert.equal(isPapercutOwner("codrive"), false);
  assert.equal(isPapercutOwner(undefined), false);
});

test("a note record without a note body is not treated as a papercut", () => {
  const impostor = buildRecord({
    sessionId: "s",
    cwd: "/tmp",
    tool: NOTE_TOOL,
    args: {},
    isError: false,
  });

  assert.equal(isPapercut(impostor), false);
  assert.deepEqual(papercutRecords([impostor]), []);
});

test("formatNotes lists papercuts newest first with owner, link, and suspects", () => {
  const older = buildNoteRecord({
    sessionId: "s",
    cwd: "/repo",
    fields: { tried: "first", got: "boom" },
    owner: "pi",
    endedAt: 1000,
  });
  const newer = buildNoteRecord({
    sessionId: "s",
    cwd: "/repo",
    fields: { tried: "second", got: "bang" },
    owner: "config",
    refCallId: "aaaabbbb",
    suspects: ["pi/lib/x.ts"],
    endedAt: 2000,
  });
  const noise = buildRecord({
    sessionId: "s",
    cwd: "/repo",
    tool: "bash",
    args: { command: "ls" },
    isError: false,
  });

  const output = formatNotes([older, noise, newer]);

  assert.match(output, /2 papercuts/);
  assert.equal(output.indexOf("tried: second") < output.indexOf("tried: first"), true);
  assert.match(output, /owner=config/);
  assert.match(output, /owner=pi/);
  assert.match(output, /about call: aaaabbbb/);
  assert.match(output, /suspects: pi\/lib\/x\.ts/);
  assert.equal(output.includes("command"), false);
});

test("formatNotes reports an empty queue instead of a bare list", () => {
  assert.equal(formatNotes([]), "tool-audit: no papercuts filed");
});

test("retention drops aged-out calls but never a papercut", () => {
  const now = Date.now();
  const oldCall: AuditRecord = {
    ts: new Date(now - 90 * DAY_MS).toISOString(),
    sessionId: "s",
    agentId: "s",
    cwd: "/repo",
    tool: "bash",
    args: "{}",
    outcome: "ok",
    preview: "",
  };
  const freshCall: AuditRecord = { ...oldCall, ts: new Date(now).toISOString() };
  const oldNote = buildNoteRecord({
    sessionId: "s",
    cwd: "/repo",
    fields: { tried: "ancient", got: "still unfixed" },
    endedAt: now - 900 * DAY_MS,
  });

  const { keep, dropped } = retainRecords([oldCall, freshCall, oldNote], now - 30 * DAY_MS);

  assert.deepEqual(dropped, [oldCall]);
  assert.equal(keep.length, 2);
  assert.equal(keep.some(isPapercut), true);
});

test("retention keeps records with an unparseable timestamp rather than deleting them", () => {
  const broken: AuditRecord = {
    ts: "not-a-date",
    sessionId: "s",
    agentId: "s",
    cwd: "/repo",
    tool: "bash",
    args: "{}",
    outcome: "ok",
    preview: "",
  };

  const { keep, dropped } = retainRecords([broken], Date.now());

  assert.deepEqual(keep, [broken]);
  assert.deepEqual(dropped, []);
});

test("pruneAuditDir rewrites daily files on disk and preserves every papercut", (t) => {
  const dir = tempDir("pi-papercut-prune-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const now = Date.now();
  const oldDay = new Date(now - 90 * DAY_MS);
  const staleCall: AuditRecord = {
    ts: oldDay.toISOString(),
    sessionId: "s",
    agentId: "s",
    cwd: "/repo",
    tool: "bash",
    args: "{}",
    outcome: "error",
    preview: "boom",
  };
  const staleNote = buildNoteRecord({
    sessionId: "s",
    cwd: "/repo",
    fields: { tried: "old", got: "unfixed" },
    owner: "config",
    endedAt: oldDay.getTime(),
  });
  writeRecord(dir, staleCall, oldDay);
  writeRecord(dir, staleNote, oldDay);

  const result = pruneAuditDir(dir, { retentionDays: 30, now });

  assert.equal(result.dropped, 1);
  assert.equal(result.kept, 1);
  const remaining = readAllRecords(dir);
  assert.equal(remaining.length, 1);
  assert.equal(isPapercut(remaining[0]), true);
  assert.equal(readFileSync(dailyFilePath(dir, oldDay), "utf8").includes("boom"), false);
});

test("pruneAuditDir leaves untouched files alone and tolerates a missing directory", (t) => {
  const dir = tempDir("pi-papercut-prune-noop-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const fresh = buildRecord({
    sessionId: "s",
    cwd: "/repo",
    tool: "bash",
    args: {},
    isError: false,
  });
  writeRecord(dir, fresh);
  const path = dailyFilePath(dir);
  const before = readFileSync(path, "utf8");

  const result = pruneAuditDir(dir, { retentionDays: 30 });

  assert.equal(result.dropped, 0);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(pruneAuditDir(join(dir, "missing")), { files: 0, kept: 0, dropped: 0 });
});

test("pruneAuditDir skips malformed lines without losing the readable records", (t) => {
  const dir = tempDir("pi-papercut-prune-broken-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const oldDay = new Date(Date.now() - 90 * DAY_MS);
  const note = buildNoteRecord({
    sessionId: "s",
    cwd: "/repo",
    fields: { tried: "old", got: "unfixed" },
    endedAt: oldDay.getTime(),
  });
  writeFileSync(dailyFilePath(dir, oldDay), `{ not json\n${JSON.stringify(note)}\n`);

  pruneAuditDir(dir, { retentionDays: 30 });

  const remaining = readAllRecords(dir);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].callId, note.callId);
});

test("the papercut filed event channel is a stable literal", () => {
  assert.equal(PAPERCUT_FILED_EVENT, "papercut:filed");
});

test("cli note files a papercut that the notes view then lists", (t) => {
  const dir = tempDir("pi-papercut-cli-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const filed = runCli(
    [
      "note",
      "--tried", "read a png with the read tool",
      "--got", "unsupported image type",
      "--workaround", "converted to jpeg",
      "--owner", "config",
      "--suspect", "pi/lib/a.ts",
      "--suspect", "pi/lib/b.ts",
      "--cwd", "/repo",
    ],
    dir,
  );

  assert.match(filed, /filed papercut [0-9a-f]{8} \(owner config\)/);
  const listed = runCli(["notes"], dir);
  assert.match(listed, /tried: read a png with the read tool/);
  assert.match(listed, /suspects: pi\/lib\/a\.ts, pi\/lib\/b\.ts/);
});

test("cli note refuses an incomplete or misattributed papercut", (t) => {
  const dir = tempDir("pi-papercut-cli-bad-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.match(runCli(["note", "--tried", "only this"], dir), /requires --tried and --got/);
  assert.match(
    runCli(["note", "--tried", "a", "--got", "b", "--owner", "codrive"], dir),
    /--owner must be config, pi, model, or env/,
  );
  assert.equal(readAllRecords(dir).length, 0);
});

test("cli prune reports what it kept and never drops papercuts", (t) => {
  const dir = tempDir("pi-papercut-cli-prune-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const oldDay = new Date(Date.now() - 90 * DAY_MS);
  writeRecord(
    dir,
    buildNoteRecord({
      sessionId: "s",
      cwd: "/repo",
      fields: { tried: "old", got: "unfixed" },
      endedAt: oldDay.getTime(),
    }),
    oldDay,
  );

  const output = runCli(["prune", "30"], dir);

  assert.match(output, /papercuts are never dropped/);
  assert.equal(readAllRecords(dir).length, 1);
});

test("cli help documents the papercut subcommands", () => {
  const help = runCli(["--help"], tempDir("pi-papercut-help-"));
  assert.match(help, /notes\s+papercuts filed so far/);
  assert.match(help, /note \.\.\./);
  assert.match(help, /prune \[days\]/);
});
