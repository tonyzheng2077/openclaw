import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { sendMessage } from "../infra/outbound/message.js";

type CommitmentStatus = "open" | "blocked" | "done" | "cancelled";
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
  tag: "ledger" | "ledger-reminder" | "nightly-consolidation" | "heartbeat" | "ops-alert";
  text: string;
};

type HeartbeatState = {
  lastGatewayWarnAt?: string;
  lastConsolidatedDate?: string;
};

type ContractState = {
  pendingCommitmentRequired?: boolean;
  pendingTriggeredAt?: string;
  pendingTriggeredBy?: string;
  pendingTriggeredText?: string;
  nextCommitmentSeq?: number;
};

type ProactivityResolved = {
  enabled: boolean;
  contractsEnabled: boolean;
  reminderEngineEnabled: boolean;
  heartbeatDashboardEnabled: boolean;
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
  nextCheckMaxIntervalHours: number;
  nextCheckOffsetMinutes: number;
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

function normalizeDiscordTarget(raw: string): string {
  const v = raw.trim();
  if (/^channel:\d+$/.test(v)) {
    return v;
  }
  if (/^\d+$/.test(v)) {
    return `channel:${v}`;
  }
  return v;
}

function resolveConfig(cfg: OpenClawConfig): ProactivityResolved {
  const p = cfg.proactivity;
  const home = os.homedir();
  return {
    enabled: p?.enabled !== false,
    contractsEnabled: p?.contracts?.enabled !== false,
    reminderEngineEnabled: p?.reminder?.engineEnabled !== false,
    heartbeatDashboardEnabled: p?.heartbeat?.dashboardAlways !== false,
    owner: p?.owner?.trim() || "Tony",
    stateRoot: p?.stateRoot?.trim() || path.join(home, ".openclaw", "state", "proactivity"),
    assetsRoot: p?.assetsRoot?.trim() || path.join(home, ".openclaw", "workspace", "memory"),
    reportMode: p?.report?.mode === "context" ? "context" : "ops",
    reportChannel: normalizeDiscordTarget(
      p?.report?.opsChannelId?.trim() || p?.report?.channel?.trim() || "1477815403865571349",
    ),
    slaDefaultHours: Math.max(0.1, Number(ensure(p?.sla?.defaultHours, 24))),
    atRiskThresholdHours: Math.max(0.0, Number(ensure(p?.reminder?.atRiskThresholdHours, 4))),
    blockedThresholdHours: Math.max(0.0, Number(ensure(p?.reminder?.blockedThresholdHours, 12))),
    heartbeatIntervalMs: Math.max(
      60_000,
      Math.floor(ensure(p?.heartbeat?.intervalMinutes, 360) * 60_000),
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
    nextCheckMaxIntervalHours: Math.max(
      1,
      Math.floor(ensure(p?.reminder?.nextCheck?.maxIntervalHours, 48)),
    ),
    nextCheckOffsetMinutes: Math.max(
      0,
      Math.floor(ensure(p?.reminder?.nextCheck?.offsetMinutes, 1)),
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
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
}
function hoursBetween(fromIso: string, now: Date): number {
  return (now.getTime() - new Date(fromIso).getTime()) / 3600000;
}

const INTAKE_TRIGGER_RE =
  /(承诺|保证|务必反馈|promise|guarantee|must\s+reply|must\s+report\s+back)/i;
const EXPLICIT_COMMITMENT_RE = /(我承诺|我会在.+?(反馈|更新|完成)|I promise to|I commit to)/i;
const CLOSE_RE = /(已完成（(C-\d{4,})）|\b(C-\d{4,})\s+done\b)/gi;

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
  private readonly contractStateFile: string;
  private readonly heartbeatLogDir: string;
  private readonly consolidationLogDir: string;

  constructor(deps: ProactivityServiceDeps) {
    this.cfg = resolveConfig(deps.cfg);
    this.log = deps.log ?? { info: () => {}, warn: () => {}, error: () => {} };
    this.now = deps.now ?? (() => new Date());
    this.getGatewayHealth = deps.getGatewayHealth;

    this.ledgerFile = path.join(this.cfg.stateRoot, "commitments", "ledger.jsonl");
    this.eventsFile = path.join(this.cfg.stateRoot, "commitments", "events.jsonl");
    this.snapshotsDir = path.join(this.cfg.stateRoot, "commitments", "snapshots");
    this.queueFile = path.join(this.cfg.stateRoot, "notifications", "unsent-queue.jsonl");
    this.heartbeatStateFile = path.join(this.cfg.stateRoot, "watchlist", "heartbeat_state.json");
    this.contractStateFile = path.join(this.cfg.stateRoot, "contracts", "state.json");
    this.heartbeatLogDir = path.join(this.cfg.stateRoot, "logs", "heartbeat");
    this.consolidationLogDir = path.join(this.cfg.stateRoot, "logs", "consolidation");
  }

  async start() {
    if (!this.cfg.enabled) {
      return;
    }
    await Promise.all([
      mkdirp(path.dirname(this.ledgerFile)),
      mkdirp(path.dirname(this.queueFile)),
      mkdirp(path.dirname(this.heartbeatStateFile)),
      mkdirp(path.dirname(this.contractStateFile)),
      mkdirp(this.snapshotsDir),
    ]);
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
  }

  private async readLatestCommitments(): Promise<Commitment[]> {
    const all = await readJsonl<Commitment>(this.ledgerFile);
    const latest = new Map<string, Commitment>();
    for (const c of all) {
      latest.set(c.id, c);
    }
    return [...latest.values()];
  }

  private async nextCommitmentId(): Promise<string> {
    const st = await readJsonFile<ContractState>(this.contractStateFile, {});
    const seq = Math.max(1, Number(st.nextCommitmentSeq ?? 1));
    st.nextCommitmentSeq = seq + 1;
    await fs.writeFile(this.contractStateFile, JSON.stringify(st, null, 2), "utf8");
    return `C-${String(seq).padStart(4, "0")}`;
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
      id: await this.nextCommitmentId(),
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
    const all = await this.readLatestCommitments();
    const existing = all.find((c) => c.id.toLowerCase() === id.toLowerCase());
    if (!existing) {
      return false;
    }
    const next = { ...existing, status, updated_at: iso(this.now()) };
    await appendJsonl(this.ledgerFile, next);
    await appendJsonl(this.eventsFile, {
      ts: iso(this.now()),
      type: "commitment.status",
      commitment_id: existing.id,
      status,
      note,
    });
    return true;
  }

  async closeAllOpenCommitments(note?: string): Promise<number> {
    const all = await this.readLatestCommitments();
    const open = all.filter((c) => c.status === "open" || c.status === "blocked");
    for (const c of open) {
      await this.updateCommitmentStatus(c.id, "cancelled", note ?? "close-all");
    }
    return open.length;
  }

  async observeInboundUserMessage(text: string, source?: string) {
    if (!this.cfg.contractsEnabled) {
      return;
    }
    if (!INTAKE_TRIGGER_RE.test(text)) {
      return;
    }
    const st = await readJsonFile<ContractState>(this.contractStateFile, {});
    st.pendingCommitmentRequired = true;
    st.pendingTriggeredAt = iso(this.now());
    st.pendingTriggeredBy = source;
    st.pendingTriggeredText = text;
    await fs.writeFile(this.contractStateFile, JSON.stringify(st, null, 2), "utf8");
    await appendJsonl(this.eventsFile, {
      ts: iso(this.now()),
      type: "contract.intake.triggered",
      source,
      text,
    });
  }

  /**
   * Enforce/observe outbound replies for system-level contracts.
   * Returns the (possibly modified) text that must be sent to the user.
   */
  async enforceAssistantOutboundReply(text: string, source?: string): Promise<string> {
    if (!this.cfg.contractsEnabled) {
      return text;
    }
    const now = this.now();
    const nowIso = iso(now);
    const st = await readJsonFile<ContractState>(this.contractStateFile, {});

    let out = text;

    // Intake contract: if triggered, the *next* assistant reply must contain an explicit commitment sentence WITH an ID.
    if (st.pendingCommitmentRequired) {
      if (!EXPLICIT_COMMITMENT_RE.test(out)) {
        // Create a commitment immediately (system-level, not prompt-based).
        const nextSeq = Math.max(1, Math.floor(st.nextCommitmentSeq ?? 1));
        const id = `C-${String(nextSeq).padStart(4, "0")}`;
        st.nextCommitmentSeq = nextSeq + 1;

        const commitmentText = (st.pendingTriggeredText ?? "(no text)").trim().slice(0, 500);
        const createdAt = nowIso;
        const dueAt = iso(new Date(now.getTime() + this.cfg.slaDefaultHours * 3600000));
        const nextCheckAt = iso(
          new Date(now.getTime() + this.cfg.slaDefaultHours * 3600000 + 60_000),
        );

        const commitment: Commitment = {
          id,
          text: commitmentText,
          owner: this.cfg.owner,
          status: "open",
          priority: "high",
          project: "contracts/intake",
          source: source ?? st.pendingTriggeredBy ?? "unknown",
          created_at: createdAt,
          updated_at: createdAt,
          sla_hours: this.cfg.slaDefaultHours,
          due_at: dueAt,
          next_check_at: nextCheckAt,
          reminder_count: 0,
        };

        await appendJsonl(this.ledgerFile, commitment);
        await appendJsonl(this.eventsFile, {
          ts: createdAt,
          type: "commitment.created",
          commitment_id: id,
          source: commitment.source,
          text: commitment.text,
          due_at: commitment.due_at,
        });

        await this.notify({
          severity: "info",
          tag: "ledger",
          text: `[ledger] created ${id} (due≈${this.cfg.slaDefaultHours}h) — ${commitment.text.slice(0, 120)}`,
        });

        // Auto-append an explicit commitment sentence so the outbound reply becomes contract-compliant.
        const appendLine = `已承诺（${id}）：我会在完成后给你反馈。`;
        out = out.trim() ? `${out.trim()}\n\n${appendLine}` : appendLine;

        await appendJsonl(this.eventsFile, {
          ts: createdAt,
          type: "contract.intake.autofix",
          commitment_id: id,
          source,
        });
      }

      st.pendingCommitmentRequired = false;
      st.pendingTriggeredAt = undefined;
      st.pendingTriggeredBy = undefined;
      st.pendingTriggeredText = undefined;
      await fs.writeFile(this.contractStateFile, JSON.stringify(st, null, 2), "utf8");
    }

    // Close contract phrases: explicit close sentence containing ID.
    const matches = [...out.matchAll(CLOSE_RE)];
    for (const m of matches) {
      const id = (m[2] ?? m[3] ?? "").trim();
      if (id) {
        await this.updateCommitmentStatus(id, "done", "close-contract-phrase");
      }
    }

    return out;
  }

  private classifyReportable(c: Commitment, now: Date): "overdue" | "blocked" | "atRisk" | null {
    const baseHours = c.due_at
      ? (new Date(c.due_at).getTime() - now.getTime()) / 3600000
      : c.sla_hours - hoursBetween(c.created_at, now);
    if (c.status === "blocked") {
      return "blocked";
    }
    if (baseHours < 0) {
      return "overdue";
    }
    if (baseHours <= this.cfg.atRiskThresholdHours) {
      return "atRisk";
    }
    return null;
  }

  private async runReminderEngine(commitments: Commitment[], now: Date): Promise<string[]> {
    if (!this.cfg.reminderEngineEnabled) {
      return [];
    }
    const fired: string[] = [];
    for (const c of commitments) {
      if (c.status === "done" || c.status === "cancelled") {
        continue;
      }
      const kind = this.classifyReportable(c, now);
      if (!kind) {
        continue;
      }
      const nextCheckAt = c.next_check_at ? new Date(c.next_check_at).getTime() : 0;
      if (now.getTime() < nextCheckAt) {
        continue;
      }
      fired.push(`${c.id} ${kind} — ${c.text.slice(0, 120)}`);
      await this.notify({
        severity: kind === "overdue" ? "critical" : "warn",
        tag: "ledger-reminder",
        text: `${c.id} ${kind}: ${c.text}`,
      });
      const reminderCount = (c.reminder_count ?? 0) + 1;
      const maxIntervalHours = Math.max(1, Math.floor(this.cfg.nextCheckMaxIntervalHours ?? 48));
      // Linear backoff: +1h each reminder occurrence, capped.
      const backoffHours = Math.min(maxIntervalHours, Math.max(1, reminderCount));
      const offsetMinutes = Math.max(0, Math.floor(this.cfg.nextCheckOffsetMinutes ?? 1));
      const updated: Commitment = {
        ...c,
        updated_at: iso(now),
        last_reminder_at: iso(now),
        reminder_count: reminderCount,
        next_check_at: iso(
          new Date(now.getTime() + backoffHours * 3600000 + offsetMinutes * 60_000),
        ),
      };
      await appendJsonl(this.ledgerFile, updated);
      await appendJsonl(this.eventsFile, {
        ts: iso(now),
        type: "commitment.reminder",
        commitment_id: c.id,
        kind,
        reminder_count: reminderCount,
        next_check_at: updated.next_check_at,
      });
    }
    return fired;
  }

  private buildHeartbeatDashboard(
    reason: "startup" | "interval",
    commitments: Commitment[],
    now: Date,
  ): string {
    const reportable = commitments
      .filter((c) => c.status !== "done" && c.status !== "cancelled")
      .map((c) => ({ c, kind: this.classifyReportable(c, now) }))
      .filter((x) => Boolean(x.kind)) as Array<{
      c: Commitment;
      kind: "overdue" | "blocked" | "atRisk";
    }>;

    const overdue = reportable.filter((x) => x.kind === "overdue");
    const blocked = reportable.filter((x) => x.kind === "blocked");
    const atRisk = reportable.filter((x) => x.kind === "atRisk");
    const lines = [
      `heartbeat dashboard (${reason})`,
      `counts: overdue=${overdue.length}, blocked=${blocked.length}, atRisk=${atRisk.length}, totalReportable=${reportable.length}`,
      "items:",
      ...(reportable.length === 0
        ? ["- none"]
        : reportable.map(
            ({ c, kind }) =>
              `- ${c.id} [${kind}] status=${c.status} next_check_at=${c.next_check_at ?? "n/a"} text=${c.text.slice(0, 140)}`,
          )),
    ];
    return lines.join("\n");
  }

  private async ensureBootstrapJobs() {
    const hb = await readJsonFile<HeartbeatState>(this.heartbeatStateFile, {});
    const y = new Date(this.now().getTime() - 24 * 3600 * 1000);
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
    this.nightlyTimer = setTimeout(
      () => {
        const d = new Date(this.now().getTime() - 24 * 3600 * 1000);
        void this.runConsolidation(dateKeyLocal(d), "scheduled").finally(() =>
          this.armNightlyTimer(),
        );
      },
      Math.max(1000, next.getTime() - now.getTime()),
    );
  }

  private async runHeartbeatCycle(reason: "startup" | "interval") {
    if (this.heartbeatRunning) {
      return;
    }
    this.heartbeatRunning = true;
    try {
      const now = this.now();
      const commitments = await this.readLatestCommitments();
      await this.runReminderEngine(commitments, now);
      if (this.cfg.heartbeatDashboardEnabled) {
        await this.notify({
          severity: "info",
          tag: "heartbeat",
          text: this.buildHeartbeatDashboard(reason, commitments, now),
        });
      }
      await this.writeSnapshot();
    } catch (err) {
      this.log.error({ err: String(err) }, "proactivity: heartbeat failed");
    } finally {
      this.heartbeatRunning = false;
    }
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
      const events = (await readJsonl<Record<string, unknown>>(this.eventsFile)).filter(
        (e) => typeof e.ts === "string" && String(e.ts).startsWith(dayKey),
      );
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
      await fs.writeFile(
        logFile,
        JSON.stringify(
          {
            run_id: runId,
            started_at: iso(started),
            ended_at: iso(this.now()),
            status: "success",
            trigger,
            changedFiles,
          },
          null,
          2,
        ),
        "utf8",
      );
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
    }
  }

  private async writeSnapshot() {
    const commitments = await this.readLatestCommitments();
    const now = this.now();
    await fs.writeFile(
      path.join(this.snapshotsDir, `${dateKeyLocal(now)}.json`),
      JSON.stringify(
        {
          at: iso(now),
          open: commitments.filter((c) => c.status === "open" || c.status === "blocked").length,
          total: commitments.length,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  private async notify(input: { severity: Severity; tag: QueueItem["tag"]; text: string }) {
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
        to: normalizeDiscordTarget(this.cfg.reportChannel),
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
          to: normalizeDiscordTarget(this.cfg.reportChannel),
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
