import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  markAgentRunUserVisible,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import { startGatewayTurnWatchdog } from "./turn-watchdog.js";

describe("gateway turn watchdog", () => {
  const deliver = vi.fn(async () => []);

  beforeEach(() => {
    vi.useFakeTimers();
    deliver.mockClear();
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends heartbeat every interval, then completion notice when no run message was sent", async () => {
    const watchdog = startGatewayTurnWatchdog(
      { gateway: { turnWatchdog: { intervalMs: 5000 } } } as unknown as Parameters<
        typeof startGatewayTurnWatchdog
      >[0],
      { deliver },
    );

    registerAgentRunContext("run-1", {
      delivery: { channel: "discord", to: "chan-1" },
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "start" } });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "end" } });
    await vi.runAllTimersAsync();

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[0][0].payloads[0].text).toContain("Still working");
    expect(deliver.mock.calls[2][0].payloads[0].text).toContain("turn completed");

    watchdog.stop();
  });

  it("does not heartbeat/finalize after run has sent a visible message", async () => {
    const watchdog = startGatewayTurnWatchdog(
      { gateway: { turnWatchdog: { intervalMs: 5000 } } } as unknown as Parameters<
        typeof startGatewayTurnWatchdog
      >[0],
      { deliver },
    );

    registerAgentRunContext("run-2", {
      delivery: { channel: "discord", to: "chan-2" },
    });

    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } });
    markAgentRunUserVisible("run-2");
    await vi.advanceTimersByTimeAsync(4000);
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: { phase: "end" } });
    await vi.runAllTimersAsync();

    expect(deliver).not.toHaveBeenCalled();

    watchdog.stop();
  });
});
