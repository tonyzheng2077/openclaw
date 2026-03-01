import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { sendMessage } from "../infra/outbound/message.js";

type CommitmentStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
type Priority = "low" | "med" | "high";
type Severity = "info" | "warn" | "critical";

type Commitment = {
  id: string;
  created_at: string;
  updated_at: string;
  source?: string;
  text: string;
  owner: string;
  status: CommitmentStatus;
  due_at?: string;
  sla_hours: number;
  next_check_at?: string;
  priority: Priority;
  project?: string;
  last_reminder_at?: string;
  reminder_count: number;
};

type QueueItem = {
  id: string;
  createdAt: string;
  attempts: number;
  severity: Severity;
  tag: "ledger-reminder" | "nightly-consolidation" | "heartbeat";
  text: string;
};

type HeartbeatState = {
  lastHash?: string;
  lastGatewayWarnAt?: string;
  lastConsolidatedDate?: string;
  alertStates?: Record<string, string>;
};

type ProactivityResolved = {
  enabled: boolean;
  owner: string;
  stateRoot: string;
  assetsRoot: string;
  reportChannel: string;
  reportMode: "context" | "ops";
  slaDefaultHours: number;
  atRiskThresholdHours: number;
  blockedThresholdHours: number;
  heartbeatIntervalMs: number;
  heartbeatQuietMode: boolean;
  consolidationLocalTime: string;
  consolidationQuietMode: boolean;
  rollout: "shadow" | "warn_critical" | "full";
  groupChatRedaction: boolean;
  retryEveryMs: number;
  maxAttempts: number;
  degradedWarnEveryHours: number;
};

export type ProactivityServiceDeps = {
  cfg: OpenClawConfig;
  log?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  now?: () => Date;
  getGatewayHealth?: () => { ok: boolean; errorRate?: number; lastOkAt?: string };
};

function parseHHMM(value: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) {
    return { hour: 2, minute: 0 };
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { hour: 2, minute: 0 };
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 2, minute: 0 };
  }
  return { hour, minute };
}

function ensure<T>(v: T | undefined, d: T): T {
  return v === undefined ? d : v;
}

function resolveConfig(cfg: OpenClawConfig): ProactivityResolved {
  const p = cfg.proactivity;
  const home = os.homedir();
  return {
    enabled: p?.enabled !== false,
    owner: p?.owner?.trim() || "Tony",
    stateRoot: p?.stateRoot?.trim() || path.join(home, ".openclaw", "state", "proactivity"),
    assetsRoot: p?.assetsRoot?.trim() || path.join(home, ".openclaw", "workspace", "memory"),
    reportMode: p?.report?.mode === "context" ? "context" : "ops",
    reportChannel:
      p?.report?.opsChannelId?.trim() || p?.report?.channel?.trim() || "1477815403865571349",
    slaDefaultHours: Math.max(1, Math.floor(ensure(p?.sla?.defaultHours, 24))),
    atRiskThresholdHours: Math.max(1, Math.floor(ensure(p?.reminder?.atRiskThresholdHours, 4))),
    blockedThresholdHours: Math.max(1, Math.floor(ensure(p?.reminder?.blockedThresholdHours, 12))),
    heartbeatIntervalMs: Math.max(
      60_000,
      Math.floor(ensure(p?.heartbeat?.intervalMinutes, 30) * 60_000),
    ),
    heartbeatQuietMode: p?.heartbeat?.quietMode !== false,
    consolidationLocalTime: p?.consolidation?.localTime?.trim() || "02:00",
    consolidationQuietMode: p?.consolidation?.quietMode !== false,
    rollout: p?.rollout?.phase || "full",
    groupChatRedaction: p?.groupChat?.redaction !== false,
    retryEveryMs: Math.max(60_000, Math.floor(ensure(p?.queue?.retryEveryMinutes, 5) * 60_000)),
    maxAttempts: Math.max(1, Math.floor(ensure(p?.queue?.maxAttempts, 8))),
    degradedWarnEveryHours: Math.max(
      1,
      Math.floor(ensure(p?.heartbeat?.degradedModeWarnEveryHours, 6)),
    ),
  };
}

async function mkdirp(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function appendJsonl(file: string, obj: unknown) {
  await mkdirp(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(obj)}\n`, "utf8");
}

function iso(d: Date): string {
  return d.toISOString();
}

function dateKeyLocal(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hoursBetween(fromIso: string, now: Date): number {
  return (now.getTime() - new Date(fromIso).getTime()) / 3600000;
}

function normalizeTextForHash(lines: string[]) {
  return lines.join("\n").trim().toLowerCase();
}

export class ProactivityService {
  private readonly cfg: ProactivityResolved;
  private readonly log;
  private readonly now;
  private readonly getGatewayHealth;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private nightlyTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatRunning = false;

  private readonly ledgerFile: string;
  private readonly eventsFile: string;
  private readonly snapshotsDir: string;
  private readonly queueFile: string;
  private readonly heartbeatStateFile: string;
  private readonly heartbeatLogDir: string;
  private readonly consolidationLogDir: string;

  constructor(deps: ProactivityServiceDeps) {
    this.cfg = resolveConfig(deps.cfg);
    this.log = deps.log ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.now = deps.now ?? (() => new Date());
    this.getGatewayHealth = deps.getGatewayHealth;

    this.ledgerFile = path.join(this.cfg.stateRoot, "commitments", "ledger.jsonl");
    this.eventsFile = path.join(this.cfg.stateRoot, "commitments", "events.jsonl");
    this.snapshotsDir = path.join(this.cfg.stateRoot, "commitments", "snapshots");
    this.queueFile = path.join(this.cfg.stateRoot, "notifications", "unsent-queue.jsonl");
    this.heartbeatStateFile = path.join(this.cfg.stateRoot, "watchlist", "heartbeat_state.json");
    this.heartbeatLogDir = path.join(this.cfg.stateRoot, "logs", "heartbeat");
    this.consolidationLogDir = path.join(this.cfg.stateRoot, "logs", "consolidation");
  }

  async start() {
    if (!this.cfg.enabled) {
      this.log.info({ enabled: false }, "proactivity: disabled");
      return;
    }
    await mkdirp(path.dirname(this.ledgerFile));
    await mkdirp(path.dirname(this.queueFile));
    await mkdirp(path.dirname(this.heartbeatStateFile));
    await mkdirp(this.snapshotsDir);

    await this.ensureBootstrapJobs();
    await this.retryQueuedNotifications();
    await this.runHeartbeatCycle("startup");

    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeatCycle("interval");
    }, this.cfg.heartbeatIntervalMs);

    this.retryTimer = setInterval(() => {
      void this.retryQueuedNotifications();
    }, this.cfg.retryEveryMs);

    this.armNightlyTimer();
    this.log.info({ enabled: true }, "proactivity: started");
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
    }
    if (this.nightlyTimer) {
      clearTimeout(this.nightlyTimer);
    }
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.nightlyTimer = null;
  }

  async addCommitment(input: {
    text: string;
    source?: string;
    due_at?: string;
    sla_hours?: number;
    priority?: Priority;
    project?: string;
  }) {
    const now = this.now();
    const c: Commitment = {
      id: randomUUID(),
      created_at: iso(now),
      updated_at: iso(now),
      source: input.source,
      text: input.text,
      owner: this.cfg.owner,
      status: "open",
      due_at: input.due_at,
      sla_hours: Math.max(1, Math.floor(input.sla_hours ?? this.cfg.slaDefaultHours)),
      next_check_at: iso(now),
      priority: input.priority ?? "med",
      project: input.project,
      reminder_count: 0,
    };
    await appendJsonl(this.ledgerFile, c);
    await appendJsonl(this.eventsFile, {
      ts: c.created_at,
      type: "commitment.created",
      commitment_id: c.id,
      data: c,
    });
    return c;
  }

  async updateCommitmentStatus(id: string, status: CommitmentStatus, note?: string) {
    const all = await readJsonl<Commitment>(this.ledgerFile);
    const next = all.map((c) => (c.id === id ? { ...c, status, updated_at: iso(this.now()) } : c));
    await fs.writeFile(
      this.ledgerFile,
      `${next.map((x) => JSON.stringify(x)).join("\n")}\n`,
      "utf8",
    );
    await appendJsonl(this.eventsFile, {
      ts: iso(this.now()),
      type: "commitment.status",
      commitment_id: id,
      status,
      note,
    });
  }

  private async ensureBootstrapJobs() {
    // Startup catch-up: if nightly missed (host asleep/down), run once on startup.
    const hb = await readJsonFile<HeartbeatState>(this.heartbeatStateFile, {});
    const now = this.now();
    const y = new Date(now.getTime() - 24 * 3600 * 1000);
    const yesterday = dateKeyLocal(y);
    if (hb.lastConsolidatedDate !== yesterday) {
      await this.runConsolidation(yesterday, "startup-catchup");
    }
  }

  private armNightlyTimer() {
    const now = this.now();
    const { hour, minute } = parseHHMM(this.cfg.consolidationLocalTime);
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    const delay = Math.max(1000, next.getTime() - now.getTime());
    this.nightlyTimer = setTimeout(() => {
      const d = new Date(this.now().getTime() - 24 * 3600 * 1000);
      const dayKey = dateKeyLocal(d);
      void this.runConsolidation(dayKey, "scheduled").finally(() => this.armNightlyTimer());
    }, delay);
  }

  private async runHeartbeatCycle(reason: "startup" | "interval") {
    if (this.heartbeatRunning) {
      return;
    }
    this.heartbeatRunning = true;
    const startedAt = this.now();
    try {
      const commitments = await readJsonl<Commitment>(this.ledgerFile);
      const hb = await readJsonFile<HeartbeatState>(this.heartbeatStateFile, { alertStates: {} });
      const alertStates = hb.alertStates ?? {};
      const lines: string[] = [];
      const now = this.now();

      for (const c of commitments) {
        if (c.status === "done" || c.status === "cancelled") {
          continue;
        }
        const baseHours = c.due_at
          ? (new Date(c.due_at).getTime() - now.getTime()) / 3600000
          : c.sla_hours - hoursBetween(c.created_at, now);

        let alertKey = "";
        let severity: Severity = "info";
        if (
          c.status === "blocked" &&
          hoursBetween(c.updated_at, now) >= this.cfg.blockedThresholdHours
        ) {
          alertKey = "blocked";
          severity = "warn";
        } else if (baseHours < 0) {
          alertKey = "overdue";
          severity = "critical";
        } else if (baseHours <= this.cfg.atRiskThresholdHours) {
          alertKey = "at-risk";
          severity = "warn";
        }

        const stateKey = `${c.id}:${alertKey || "ok"}`;
        if (alertKey && alertStates[c.id] !== stateKey) {
          alertStates[c.id] = stateKey;
          lines.push(
            `${severity.toUpperCase()} ${c.id.slice(0, 8)} ${alertKey} — ${c.text.slice(0, 80)}${c.source ? ` [${c.source}]` : ""}`,
          );
          await this.updateCommitmentStatusReminder(c.id);
        }
      }

      // Gateway health delta.
      if (this.getGatewayHealth) {
        const h = this.getGatewayHealth();
        if (!h.ok) {
          const lastWarn = hb.lastGatewayWarnAt ? new Date(hb.lastGatewayWarnAt).getTime() : 0;
          if (now.getTime() - lastWarn >= this.cfg.degradedWarnEveryHours * 3600000) {
            lines.push(`CRITICAL gateway degraded (errorRate=${h.errorRate ?? "n/a"})`);
            hb.lastGatewayWarnAt = iso(now);
          }
        } else if (hb.lastGatewayWarnAt) {
          lines.push("INFO gateway recovered");
          hb.lastGatewayWarnAt = undefined;
        }
      }

      const normalized = normalizeTextForHash(lines);
      const shouldEmit = lines.length > 0 && normalized !== (hb.lastHash ?? "");
      if (shouldEmit) {
        hb.lastHash = normalized;
        const severity: Severity = lines.some((l) => l.startsWith("CRITICAL"))
          ? "critical"
          : lines.some((l) => l.startsWith("WARN"))
            ? "warn"
            : "info";
        await this.notify({
          severity,
          tag: "heartbeat",
          text: `heartbeat (${reason})\n${lines.join("\n")}`,
        });
      } else if (!this.cfg.heartbeatQuietMode && lines.length === 0) {
        await this.notify({
          severity: "info",
          tag: "heartbeat",
          text: "heartbeat: no major changes",
        });
      }

      hb.alertStates = alertStates;
      await fs.writeFile(this.heartbeatStateFile, JSON.stringify(hb, null, 2), "utf8");
      await appendJsonl(path.join(this.heartbeatLogDir, `${dateKeyLocal(now)}.jsonl`), {
        run_id: randomUUID(),
        started_at: iso(startedAt),
        ended_at: iso(this.now()),
        status: "ok",
        emitted: shouldEmit,
      });
      await this.writeSnapshot();
    } catch (err) {
      await appendJsonl(path.join(this.heartbeatLogDir, `${dateKeyLocal(this.now())}.jsonl`), {
        run_id: randomUUID(),
        started_at: iso(startedAt),
        ended_at: iso(this.now()),
        status: "error",
        error: String(err),
      });
      this.log.error({ err: String(err) }, "proactivity: heartbeat failed");
    } finally {
      this.heartbeatRunning = false;
    }
  }

  private async updateCommitmentStatusReminder(id: string) {
    const all = await readJsonl<Commitment>(this.ledgerFile);
    const nowIso = iso(this.now());
    const next = all.map((c) =>
      c.id === id
        ? {
            ...c,
            updated_at: nowIso,
            last_reminder_at: nowIso,
            reminder_count: (c.reminder_count ?? 0) + 1,
          }
        : c,
    );
    await fs.writeFile(
      this.ledgerFile,
      `${next.map((x) => JSON.stringify(x)).join("\n")}\n`,
      "utf8",
    );
  }

  private async runConsolidation(dayKey: string, trigger: "scheduled" | "startup-catchup") {
    const runId = randomUUID();
    const started = this.now();
    await mkdirp(this.consolidationLogDir);
    const logFile = path.join(this.consolidationLogDir, `${dayKey}.json`);
    const changedFiles: string[] = [];
    try {
      const dailyDir = path.join(this.cfg.assetsRoot, "daily");
      const memoryFile = path.join(this.cfg.assetsRoot, "MEMORY.md");
      await mkdirp(dailyDir);
      await mkdirp(path.dirname(memoryFile));
      const dailyFile = path.join(dailyDir, `${dayKey}.md`);

      const events = (await readJsonl<Record<string, unknown>>(this.eventsFile)).filter((e) => {
        const ts = e.ts;
        return typeof ts === "string" && ts.startsWith(dayKey);
      });
      const summary = [
        `# Daily Summary (${dayKey})`,
        "",
        `- commitments events: ${events.length}`,
        "- consolidation inputs: A+B (C deferred)",
      ].join("\n");

      let dailyCurrent = "";
      try {
        dailyCurrent = await fs.readFile(dailyFile, "utf8");
      } catch {}
      if (!dailyCurrent.includes(`# Daily Summary (${dayKey})`)) {
        await fs.writeFile(dailyFile, `${dailyCurrent.trim()}\n\n${summary}\n`, "utf8");
        changedFiles.push(dailyFile);
      }

      let memoryCurrent = "";
      try {
        memoryCurrent = await fs.readFile(memoryFile, "utf8");
      } catch {}
      const marker = `## ${dayKey}`;
      if (!memoryCurrent.includes(marker)) {
        await fs.writeFile(
          memoryFile,
          `${memoryCurrent.trim()}\n\n${marker}\n- Consolidated from commitments/events (A+B).\n`,
          "utf8",
        );
        changedFiles.push(memoryFile);
      }

      const hb = await readJsonFile<HeartbeatState>(this.heartbeatStateFile, {});
      hb.lastConsolidatedDate = dayKey;
      await fs.writeFile(this.heartbeatStateFile, JSON.stringify(hb, null, 2), "utf8");

      const status = "success";
      await fs.writeFile(
        logFile,
        JSON.stringify(
          {
            run_id: runId,
            started_at: iso(started),
            ended_at: iso(this.now()),
            status,
            trigger,
            changedFiles,
          },
          null,
          2,
        ),
        "utf8",
      );

      if (!this.cfg.consolidationQuietMode || changedFiles.length > 0) {
        await this.notify({
          severity: "info",
          tag: "nightly-consolidation",
          text: `nightly consolidation ${status}\nchanged: ${changedFiles.length ? changedFiles.join(", ") : "none"}`,
        });
      }
    } catch (err) {
      await fs.writeFile(
        logFile,
        JSON.stringify(
          {
            run_id: runId,
            started_at: iso(started),
            ended_at: iso(this.now()),
            status: "fail",
            trigger,
            error: String(err),
            changedFiles,
          },
          null,
          2,
        ),
        "utf8",
      );
      await this.notify({
        severity: "critical",
        tag: "nightly-consolidation",
        text: `nightly consolidation fail: ${String(err)}`,
      });
    }
  }

  private async writeSnapshot() {
    const commitments = await readJsonl<Commitment>(this.ledgerFile);
    const now = this.now();
    const file = path.join(this.snapshotsDir, `${dateKeyLocal(now)}.json`);
    await fs.writeFile(
      file,
      JSON.stringify(
        {
          at: iso(now),
          open: commitments.filter((c) => !["done", "cancelled"].includes(c.status)).length,
          total: commitments.length,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  private async notify(input: {
    severity: Severity;
    tag: "ledger-reminder" | "nightly-consolidation" | "heartbeat";
    text: string;
  }) {
    if (this.cfg.rollout === "shadow") {
      return;
    }
    if (this.cfg.rollout === "warn_critical" && input.severity === "info") {
      return;
    }
    const body = `[${input.tag}] ${input.text}`;
    try {
      await sendMessage({
        channel: "discord",
        to: this.cfg.reportChannel,
        content: body,
      });
    } catch {
      const q: QueueItem = {
        id: randomUUID(),
        createdAt: iso(this.now()),
        attempts: 0,
        severity: input.severity,
        tag: input.tag,
        text: input.text,
      };
      await appendJsonl(this.queueFile, q);
    }
  }

  private async retryQueuedNotifications() {
    const queued = await readJsonl<QueueItem>(this.queueFile);
    if (queued.length === 0) {
      return;
    }
    const keep: QueueItem[] = [];
    for (const item of queued) {
      try {
        await sendMessage({
          channel: "discord",
          to: this.cfg.reportChannel,
          content: `[${item.tag}] ${item.text}`,
        });
      } catch {
        const attempts = (item.attempts ?? 0) + 1;
        if (attempts < this.cfg.maxAttempts) {
          keep.push({ ...item, attempts });
        }
      }
    }
    await fs.writeFile(
      this.queueFile,
      keep.length ? `${keep.map((x) => JSON.stringify(x)).join("\n")}\n` : "",
      "utf8",
    );
  }
}
