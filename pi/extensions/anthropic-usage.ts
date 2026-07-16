import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionPoller } from "../lib/usage-lifecycle.ts";

/**
 * Anthropic subscription usage, migrated from the Claude Code statusline
 * usage gauge.
 *
 * - Powerline footer segment (via powerline.customItems in settings):
 *   "5h 57% · 7d 10%", green under 50%, yellow 50-79%, red 80%+.
 *   Exactly one of the three status keys is set at a time, so the
 *   powerline item picks up the matching color.
 * - /usage command: full bars with reset times on demand.
 * - One-time warning toast when the 5h window crosses 80%.
 */

const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const WARN_THRESHOLD = 80;
// Minimum spacing between live API polls, and how often the background timer ticks.
const REFRESH_INTERVAL_MS = 30 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;
const STATUS_KEYS = ["sub-usage-ok", "sub-usage-warn", "sub-usage-crit"] as const;

interface UsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

interface Usage {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
}

export default function (pi: ExtensionAPI) {
  let lastFetchAt = 0;
  let warnedThisWindow = false;
  let lastResetsAt = "";

  let sessionActive = false;
  let refreshController: AbortController | undefined;

  async function refresh(ctx: ExtensionContext, force = false): Promise<Usage | undefined> {
    const now = Date.now();
    if (!sessionActive || (!force && now - lastFetchAt < REFRESH_INTERVAL_MS)) return;
    lastFetchAt = now;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;

    try {
      const usage = await fetchUsage(controller.signal);
      if (!sessionActive || refreshController !== controller) return;
      updateFooter(ctx, usage);
      maybeWarn(ctx, usage);
      return usage;
    } catch {
      return undefined; // usage display must never break a session
    } finally {
      if (refreshController === controller) refreshController = undefined;
    }
  }

  function updateFooter(ctx: ExtensionContext, usage: Usage): void {
    const fiveHour = Math.round(usage.five_hour.utilization ?? 0);
    const sevenDay = Math.round(usage.seven_day.utilization ?? 0);
    const fiveReset = compactReset(usage.five_hour.resets_at);
    const sevenReset = compactReset(usage.seven_day.resets_at);
    const text = `5h ${miniBar(fiveHour)} ${fiveHour}% ${fiveReset} · 7d ${miniBar(sevenDay)} ${sevenDay}% ${sevenReset}`;
    const activeKey =
      fiveHour >= WARN_THRESHOLD ? "sub-usage-crit" : fiveHour >= 50 ? "sub-usage-warn" : "sub-usage-ok";
    for (const key of STATUS_KEYS) {
      ctx.ui.setStatus(key, key === activeKey ? text : undefined);
    }
  }

  function maybeWarn(ctx: ExtensionContext, usage: Usage): void {
    const fiveHour = usage.five_hour;
    if (fiveHour.resets_at !== lastResetsAt) {
      lastResetsAt = fiveHour.resets_at ?? "";
      warnedThisWindow = false;
    }
    if ((fiveHour.utilization ?? 0) >= WARN_THRESHOLD && !warnedThisWindow) {
      warnedThisWindow = true;
      ctx.ui.notify(
        `Anthropic 5h window at ${Math.round(fiveHour.utilization!)}% · resets ${formatReset(fiveHour.resets_at)}`,
        "warning",
      );
    }
  }

  let activeCtx: ExtensionContext | undefined;
  const poller = new SessionPoller({ setInterval, clearInterval }, POLL_INTERVAL_MS);

  function startPolling(ctx: ExtensionContext): void {
    activeCtx = ctx;
    poller.start(() => {
      if (activeCtx) void refresh(activeCtx);
    });
  }

  function cleanup(ctx?: ExtensionContext): void {
    poller.stop();
    refreshController?.abort();
    refreshController = undefined;
    sessionActive = false;
    const footerContext = ctx ?? activeCtx;
    for (const key of STATUS_KEYS) footerContext?.ui.setStatus(key, undefined);
    activeCtx = undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    cleanup();
    sessionActive = true;
    startPolling(ctx);
    void refresh(ctx, true);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cleanup(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!sessionActive) return;
    activeCtx = ctx;
    void refresh(ctx);
  });

  pi.registerCommand("usage", {
    description: "Show Anthropic subscription usage (5h window + 7 days)",
    handler: async (_args, ctx) => {
      const usage = await refresh(ctx, true);
      if (!usage) {
        ctx.ui.notify("Usage lookup failed (token may need refresh; send a message and retry)", "error");
        return;
      }
      ctx.ui.notify(formatUsage(usage), "info");
    },
  });
}

async function fetchUsage(signal: AbortSignal): Promise<Usage> {
  const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  const token = auth?.anthropic?.access;
  if (!token) throw new Error("no Anthropic OAuth token in auth.json");

  const res = await fetch(USAGE_URL, {
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Usage;
}

function formatUsage(usage: Usage): string {
  return [
    `5h   ${bar(usage.five_hour.utilization)} · resets ${formatReset(usage.five_hour.resets_at)}`,
    `7d   ${bar(usage.seven_day.utilization)} · resets ${formatReset(usage.seven_day.resets_at)}`,
  ].join("\n");
}

/** Compact 10-cell bar with half-block precision for the footer. */
function miniBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const cells = clamped / 10;
  const full = Math.floor(cells);
  const half = cells - full >= 0.5 ? 1 : 0;
  return "█".repeat(full) + "▌".repeat(half) + "░".repeat(10 - full - half);
}

function bar(utilization: number | null): string {
  const pct = Math.max(0, Math.min(100, Math.round(utilization ?? 0)));
  const filled = Math.round(pct / 5);
  return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${pct}%`;
}

/** Compact reset countdown for the footer, e.g. "(3h)", "(12m)", "(2d)". */
function compactReset(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const deltaMs = new Date(resetsAt).getTime() - Date.now();
  if (deltaMs <= 0) return "(now)";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `(${minutes}m)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `(${hours}h)`;
  return `(${Math.round(hours / 24)}d)`;
}

function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return "unknown";
  const reset = new Date(resetsAt);
  const deltaMs = reset.getTime() - Date.now();
  const local = reset.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
  if (deltaMs <= 0) return "now";
  const hours = Math.floor(deltaMs / 3600_000);
  const minutes = Math.round((deltaMs % 3600_000) / 60_000);
  const inText = hours > 24 ? `in ${Math.round(hours / 24)}d` : hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`;
  return `${local} (${inText})`;
}
