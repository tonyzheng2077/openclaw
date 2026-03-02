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

  it("heartbeat always emits dashboard with full reportable list", async () => {
    const root = await mkTmp("oc-p-dashboard-");
    const now = new Date("2026-03-01T20:00:00.000Z");
    const svc = new ProactivityService({
      cfg: {
        proactivity: {
          enabled: true,
          stateRoot: path.join(root, "state"),
          assetsRoot: path.join(root, "assets"),
          report: { opsChannelId: "1477815403865571349" },
          heartbeat: { intervalMinutes: 360, dashboardAlways: true },
          sla: { defaultHours: 2 },
        },
      },
      now: () => now,
    });

    await svc.start();
    await svc.addCommitment({ text: "item A", sla_hours: 2 });
    await (
      svc as unknown as { runHeartbeatCycle: (r: "startup" | "interval") => Promise<void> }
    ).runHeartbeatCycle("interval");

    const hbCall = sendMessageMock.mock.calls.find((c) =>
      String(c?.[0]?.content ?? "").includes("[heartbeat]"),
    );
    expect(hbCall).toBeTruthy();
    expect(String(hbCall?.[0]?.content ?? "")).toContain("counts: overdue=");
    expect(String(hbCall?.[0]?.content ?? "")).toContain("items:");
    svc.stop();
  });

  it("next_check_at reminder engine backs off with max 48h", async () => {
    const root = await mkTmp("oc-p-reminder-");
    const now = new Date("2026-03-01T20:00:00.000Z");
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
    const c = await svc.addCommitment({ text: "overdue item", due_at: "2026-03-01T19:00:00.000Z" });
    await (
      svc as unknown as { runHeartbeatCycle: (r: "startup" | "interval") => Promise<void> }
    ).runHeartbeatCycle("interval");

    const ledger = await fs.readFile(
      path.join(root, "state", "commitments", "ledger.jsonl"),
      "utf8",
    );
    const rows = ledger
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { id: string; reminder_count?: number; next_check_at?: string },
      );
    const latest = rows.toReversed().find((x) => x.id === c.id);
    expect(latest?.reminder_count).toBeGreaterThanOrEqual(1);
    const deltaH = (new Date(String(latest?.next_check_at)).getTime() - now.getTime()) / 3600000;
    expect(deltaH).toBeLessThanOrEqual(48);
    svc.stop();
  });

  it("logs contract violation + critical alert when commitment sentence missing", async () => {
    const root = await mkTmp("oc-p-contract-");
    const now = new Date("2026-03-01T20:00:00.000Z");
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
    await svc.observeInboundUserMessage("please promise you'll report back", "discord:channel:1");
    await svc.observeAssistantOutboundReply("got it", "discord:channel:1");
    const sent = sendMessageMock.mock.calls.map((c) => String(c?.[0]?.content ?? "")).join("\n");
    expect(sent).toContain("[ops-alert]");
    const events = await fs.readFile(
      path.join(root, "state", "commitments", "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("contract.violation");
    svc.stop();
  });

  it("close phrase marks commitment done", async () => {
    const root = await mkTmp("oc-p-close-");
    const now = new Date("2026-03-01T20:00:00.000Z");
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
    const c = await svc.addCommitment({ text: "do task" });
    await svc.observeAssistantOutboundReply(`${c.id} done`, "discord:channel:1");
    const ledger = await fs.readFile(
      path.join(root, "state", "commitments", "ledger.jsonl"),
      "utf8",
    );
    const latest = ledger
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; status: string })
      .toReversed()
      .find((x) => x.id === c.id);
    expect(latest?.status).toBe("done");
    svc.stop();
  });
});
