import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

type WatchdogDeps = {
  setInterval?: typeof global.setInterval;
  clearInterval?: typeof global.clearInterval;
  deliver?: typeof deliverOutboundPayloads;
};

type TrackedRun = {
  runId: string;
  status: "running" | "ok" | "error";
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  startedAt: number;
  heartbeatsSent: number;
  timer: ReturnType<typeof setInterval>;
};

function resolveWatchdogConfig(cfg: OpenClawConfig) {
  const enabled = cfg.gateway?.turnWatchdog?.enabled ?? true;
  const intervalMs = Math.max(5_000, cfg.gateway?.turnWatchdog?.intervalMs ?? DEFAULT_INTERVAL_MS);
  return { enabled, intervalMs };
}

function getRunVisibleAt(runId: string): {
  first?: number;
  last?: number;
} {
  const ctx = getAgentRunContext(runId);
  return {
    first: typeof ctx?.firstUserVisibleAt === "number" ? ctx.firstUserVisibleAt : undefined,
    last: typeof ctx?.lastUserVisibleAt === "number" ? ctx.lastUserVisibleAt : undefined,
  };
}

function heartbeatText(minutes: number): string {
  return `Still working… this turn is taking longer than expected (${minutes}m+).`;
}

function completionText(status: "ok" | "error"): string {
  if (status === "ok") {
    return "Done. This turn completed.";
  }
  return "This turn ended with an error before producing a reply.";
}

export type GatewayTurnWatchdog = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

export function startGatewayTurnWatchdog(
  cfg: OpenClawConfig,
  deps: WatchdogDeps = {},
): GatewayTurnWatchdog {
  const setInt = deps.setInterval ?? setInterval;
  const clearInt = deps.clearInterval ?? clearInterval;
  const deliver = deps.deliver ?? deliverOutboundPayloads;

  let activeCfg = cfg;
  let settings = resolveWatchdogConfig(activeCfg);
  const runs = new Map<string, TrackedRun>();

  const cleanupRun = (runId: string) => {
    const state = runs.get(runId);
    if (!state) {
      return;
    }
    clearInt(state.timer);
    runs.delete(runId);
  };

  const maybeFinalize = async (runId: string, status: "ok" | "error") => {
    const state = runs.get(runId);
    if (!state) {
      return;
    }
    clearInt(state.timer);
    runs.delete(runId);

    const { first: firstVisibleAt, last: lastVisibleAt } = getRunVisibleAt(runId);

    // For successful turns, don't add extra "Done" noise if the run produced any user-visible output.
    if (status === "ok" && typeof firstVisibleAt === "number") {
      return;
    }

    // Avoid duplicating the normal final reply: if we sent something very recently, assume the run concluded normally.
    if (typeof lastVisibleAt === "number" && Date.now() - lastVisibleAt < 1500) {
      return;
    }

    const normalizedChannel = normalizeMessageChannel(state.channel);
    if (!normalizedChannel || !isDeliverableMessageChannel(normalizedChannel)) {
      return;
    }

    await deliver({
      cfg: activeCfg,
      channel: normalizedChannel,
      to: state.to,
      accountId: state.accountId,
      threadId: state.threadId ?? null,
      payloads: [{ text: completionText(status) }],
      bestEffort: true,
      silent: true,
    }).catch(() => {});
  };

  const startRun = (runId: string) => {
    if (!settings.enabled || runs.has(runId)) {
      return;
    }
    const context = getAgentRunContext(runId);
    if (!context?.delivery || context.isHeartbeat) {
      return;
    }
    const normalizedChannel = normalizeMessageChannel(context.delivery.channel);
    if (!normalizedChannel || !isDeliverableMessageChannel(normalizedChannel)) {
      return;
    }

    const state: Omit<TrackedRun, "timer"> = {
      runId,
      status: "running",
      channel: normalizedChannel,
      to: context.delivery.to,
      accountId: context.delivery.accountId,
      threadId: context.delivery.threadId,
      startedAt: Date.now(),
      heartbeatsSent: 0,
    };

    const timer = setInt(() => {
      const current = runs.get(runId);
      if (!current || current.status !== "running") {
        return;
      }
      const { last: lastVisibleAt } = getRunVisibleAt(runId);
      const now = Date.now();
      const lastActivityAt = lastVisibleAt ?? current.startedAt;
      if (now - lastActivityAt < settings.intervalMs) {
        return;
      }

      current.heartbeatsSent += 1;
      const minutes = Math.max(1, Math.floor((now - current.startedAt) / 60_000));
      void deliver({
        cfg: activeCfg,
        channel: current.channel,
        to: current.to,
        accountId: current.accountId,
        threadId: current.threadId ?? null,
        payloads: [{ text: heartbeatText(minutes) }],
        bestEffort: true,
        silent: true,
      }).catch(() => {});
    }, settings.intervalMs);

    runs.set(runId, {
      ...state,
      timer,
    });
  };

  const unsub = onAgentEvent((evt) => {
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      startRun(evt.runId);
      return;
    }
    if (phase === "end") {
      void maybeFinalize(evt.runId, "ok");
      return;
    }
    if (phase === "error") {
      void maybeFinalize(evt.runId, "error");
      return;
    }
  });

  return {
    stop: () => {
      unsub();
      for (const [runId] of runs) {
        cleanupRun(runId);
      }
    },
    updateConfig: (nextCfg) => {
      settings = resolveWatchdogConfig(nextCfg);
      activeCfg = nextCfg;
    },
  };
}
