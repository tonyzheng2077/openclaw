import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessageMock = vi.fn();
vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

import { ProactivityService } from "./service.js";

async function mkTmp(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("proactivity service", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue({ messageId: "m1" });
  });

  it("dedupes repeated at-risk heartbeat reminders", async () => {
    const root = await mkTmp("oc-p-1-");
    const now = new Date("2026-03-01T20:00:00.000Z");
    const svc = new ProactivityService({
      cfg: {
        proactivity: {
          enabled: true,
          stateRoot: path.join(root, "state"),
          assetsRoot: path.join(root, "assets"),
          report: { opsChannelId: "1477815403865571349" },
          heartbeat: { intervalMinutes: 30 },
          sla: { defaultHours: 2 },
          reminder: { atRiskThresholdHours: 4 },
        },
      },
      now: () => now,
    });

    await svc.start();
    await svc.addCommitment({ text: "finish patch", sla_hours: 2 });
    await (
      svc as unknown as { runHeartbeatCycle: (r: "startup" | "interval") => Promise<void> }
    ).runHeartbeatCycle("interval");
    await (
      svc as unknown as { runHeartbeatCycle: (r: "startup" | "interval") => Promise<void> }
    ).runHeartbeatCycle("interval");

    const heartbeatCalls = sendMessageMock.mock.calls.filter((c) =>
      String(c?.[0]?.content ?? "").includes("[heartbeat]"),
    );
    expect(heartbeatCalls.length).toBe(1);
    svc.stop();
  });

  it("nightly consolidation is idempotent per date key", async () => {
    const root = await mkTmp("oc-p-2-");
    const now = new Date("2026-03-02T10:00:00.000Z");
    const svc = new ProactivityService({
      cfg: {
        proactivity: {
          enabled: true,
          stateRoot: path.join(root, "state"),
          assetsRoot: path.join(root, "assets"),
          report: { opsChannelId: "1477815403865571349" },
        },
      },
      now: () => now,
    });

    await svc.start();
    await (
      svc as unknown as {
        runConsolidation: (
          dayKey: string,
          trigger: "scheduled" | "startup-catchup",
        ) => Promise<void>;
      }
    ).runConsolidation("2026-03-01", "scheduled");
    await (
      svc as unknown as {
        runConsolidation: (
          dayKey: string,
          trigger: "scheduled" | "startup-catchup",
        ) => Promise<void>;
      }
    ).runConsolidation("2026-03-01", "scheduled");

    const dailyFile = path.join(root, "assets", "daily", "2026-03-01.md");
    const content = await fs.readFile(dailyFile, "utf8");
    const matches = content.match(/# Daily Summary \(2026-03-01\)/g) ?? [];
    expect(matches.length).toBe(1);
    svc.stop();
  });

  it("queues and retries failed notifications", async () => {
    const root = await mkTmp("oc-p-3-");
    const now = new Date("2026-03-01T20:00:00.000Z");
    const svc = new ProactivityService({
      cfg: {
        proactivity: {
          enabled: true,
          stateRoot: path.join(root, "state"),
          assetsRoot: path.join(root, "assets"),
          report: { opsChannelId: "1477815403865571349" },
          heartbeat: { intervalMinutes: 30 },
        },
      },
      now: () => now,
    });

    await svc.start();
    sendMessageMock
      .mockRejectedValueOnce(new Error("discord down"))
      .mockResolvedValue({ messageId: "m2" });
    await svc.addCommitment({ text: "overdue item", due_at: "2026-03-01T19:00:00.000Z" });
    await (
      svc as unknown as { runHeartbeatCycle: (r: "startup" | "interval") => Promise<void> }
    ).runHeartbeatCycle("interval");

    const queueFile = path.join(root, "state", "notifications", "unsent-queue.jsonl");
    const queuedRaw = await fs.readFile(queueFile, "utf8");
    expect(queuedRaw.trim().length).toBeGreaterThan(0);

    await (
      svc as unknown as { retryQueuedNotifications: () => Promise<void> }
    ).retryQueuedNotifications();
    const after = await fs.readFile(queueFile, "utf8");
    expect(after.trim()).toBe("");
    svc.stop();
  });
});
