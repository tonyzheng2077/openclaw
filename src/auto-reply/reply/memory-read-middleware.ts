import { spawn } from "node:child_process";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { resolveSessionAgentId, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../../agents/workspace.js";
import { logVerbose } from "../../globals.js";

type MemoryReadMiddlewareMode = "hard_gate" | "shadow";

type MemoryReadContract = {
  turn_id?: string;
  read_intent?: { memory_relevant?: boolean };
  source_receipt_path?: string | null;
  source_receipt?: { hit?: boolean };
  claim_gate?: { allowed?: boolean; reason?: string };
  pre_answer?: {
    allow_reply?: boolean;
    deny_reason?: string | null;
    safe_fallback?: string | null;
    miss_disclosure_required?: boolean;
    miss_disclosure_template?: string | null;
  };
  telemetry_log_path?: string;
};

type MiddlewareConfigResolved = {
  enabled: boolean;
  mode: MemoryReadMiddlewareMode;
  command: string;
  commandArgs: string[];
  timeoutMs: number;
  denyOnError: boolean;
  requireSourceReceipt: boolean;
  transformDeniedClaims: boolean;
};

function resolveMiddlewareConfig(cfg: OpenClawConfig): MiddlewareConfigResolved {
  const raw = cfg.memory?.readMiddleware;
  return {
    enabled: raw?.enabled === true,
    mode: raw?.mode === "shadow" ? "shadow" : "hard_gate",
    command: raw?.command?.trim() || "memory/system/hooks/pre-answer-read-interceptor.sh",
    commandArgs: Array.isArray(raw?.commandArgs) ? raw.commandArgs.filter(Boolean) : [],
    timeoutMs: typeof raw?.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : 15000,
    denyOnError: raw?.denyOnError !== false,
    requireSourceReceipt: raw?.requireSourceReceipt !== false,
    transformDeniedClaims: raw?.transformDeniedClaims !== false,
  };
}

function resolveUserText(ctx: FinalizedMsgContext): string {
  return (
    (typeof ctx.BodyForCommands === "string" && ctx.BodyForCommands) ||
    (typeof ctx.CommandBody === "string" && ctx.CommandBody) ||
    (typeof ctx.RawBody === "string" && ctx.RawBody) ||
    (typeof ctx.Body === "string" && ctx.Body) ||
    ""
  );
}

function resolveChannel(ctx: FinalizedMsgContext): string {
  return String(ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
}

function parseContractFromStdout(stdout: string): MemoryReadContract | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as MemoryReadContract;
  } catch {
    const start = trimmed.lastIndexOf("{");
    if (start >= 0) {
      const maybe = trimmed.slice(start);
      try {
        return JSON.parse(maybe) as MemoryReadContract;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function runInterceptor(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  proposedReply: string;
  middleware: MiddlewareConfigResolved;
}): Promise<{ contract: MemoryReadContract | null; error?: string }> {
  const { cfg, ctx, proposedReply, middleware } = params;
  const sessionId = (ctx.SessionKey || "unknown").trim() || "unknown";
  const channel = resolveChannel(ctx);
  const turnId =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast ?? undefined;

  const agentId = resolveSessionAgentId({
    sessionKey: sessionId,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const command = path.isAbsolute(middleware.command)
    ? middleware.command
    : path.join(workspaceDir, middleware.command);

  const args = [
    ...middleware.commandArgs,
    "--text",
    resolveUserText(ctx),
    "--proposed-reply",
    proposedReply,
    "--session-id",
    sessionId,
    "--channel",
    channel,
    ...(turnId ? ["--turn-id", String(turnId)] : []),
  ];

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: workspaceDir,
      env: {
        ...process.env,
        OPENCLAW_SESSION_ID: sessionId,
        OPENCLAW_CHANNEL_ID: channel,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, middleware.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const detail = err instanceof Error ? err.message : String(err);
      resolve({ contract: null, error: `spawn_error:${detail}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ contract: null, error: "timeout" });
        return;
      }
      const contract = parseContractFromStdout(stdout);
      if (!contract) {
        resolve({
          contract: null,
          error:
            `invalid_contract_json: exit=${code ?? "unknown"}` +
            (stderr ? ` stderr=${stderr.trim()}` : ""),
        });
        return;
      }
      resolve({ contract });
    });
  });
}

function buildFallbackText(contract: MemoryReadContract | null): string {
  const safe = contract?.pre_answer?.safe_fallback?.trim();
  if (safe) {
    return safe;
  }
  const missTemplate = contract?.pre_answer?.miss_disclosure_template?.trim();
  if (missTemplate) {
    return missTemplate;
  }
  return "I couldn't verify that from memory right now, so I don't want to state it confidently.";
}

function attachMetadata(replies: ReplyPayload[], contract: MemoryReadContract): ReplyPayload[] {
  const memoryRelevant = contract.read_intent?.memory_relevant === true;
  const sourceReceiptPath = contract.source_receipt_path ?? undefined;
  const sourceHit = contract.source_receipt?.hit === true;
  const claimAllowed = contract.claim_gate?.allowed !== false;

  return replies.map((reply) => ({
    ...reply,
    channelData: {
      ...reply.channelData,
      memoryRead: {
        turnId: contract.turn_id,
        memoryRelevant,
        sourceReceiptPath,
        sourceHit,
        claimAllowed,
        telemetryLogPath: contract.telemetry_log_path,
      },
    },
  }));
}

export async function applyMemoryReadMiddlewareToReplies(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  replies: ReplyPayload[];
}): Promise<ReplyPayload[]> {
  const middleware = resolveMiddlewareConfig(params.cfg);
  if (!middleware.enabled || params.replies.length === 0) {
    return params.replies;
  }

  const proposedReply = params.replies
    .map((reply) => reply.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n\n");

  const intercepted = await runInterceptor({
    cfg: params.cfg,
    ctx: params.ctx,
    proposedReply,
    middleware,
  });

  if (!intercepted.contract) {
    logVerbose(`memory-read-middleware: interceptor failed (${intercepted.error ?? "unknown"})`);
    if (middleware.mode === "shadow" || !middleware.denyOnError) {
      return params.replies;
    }
    return [{ text: buildFallbackText(null) }];
  }

  const contract = intercepted.contract;
  const memoryRelevant = contract.read_intent?.memory_relevant === true;
  const sourceReceiptPath = contract.source_receipt_path ?? undefined;
  const claimAllowed = contract.claim_gate?.allowed !== false;
  const preAllow = contract.pre_answer?.allow_reply !== false;

  const deniedByMissingReceipt =
    middleware.requireSourceReceipt &&
    memoryRelevant &&
    (!sourceReceiptPath || sourceReceiptPath.trim() === "");
  const deniedByClaimGate = memoryRelevant && !claimAllowed;
  const deniedByPreAnswer = !preAllow;

  if (middleware.mode === "shadow") {
    return attachMetadata(params.replies, contract);
  }

  if (
    deniedByMissingReceipt ||
    deniedByPreAnswer ||
    (deniedByClaimGate && !middleware.transformDeniedClaims)
  ) {
    return [{ text: buildFallbackText(contract) }];
  }

  if (deniedByClaimGate && middleware.transformDeniedClaims) {
    return [
      {
        text: buildFallbackText(contract),
        channelData: {
          memoryRead: {
            turnId: contract.turn_id,
            transformed: true,
            denyReason: contract.claim_gate?.reason,
            sourceReceiptPath,
          },
        },
      },
    ];
  }

  const withMeta = attachMetadata(params.replies, contract);
  const missDisclosureRequired = contract.pre_answer?.miss_disclosure_required === true;
  const missTemplate = contract.pre_answer?.miss_disclosure_template?.trim();
  if (!memoryRelevant || !missDisclosureRequired || !missTemplate) {
    return withMeta;
  }

  const first = withMeta[0];
  const text = first.text?.trim();
  const mergedText = text ? `${missTemplate}\n\n${text}` : missTemplate;
  return [{ ...first, text: mergedText }, ...withMeta.slice(1)];
}
