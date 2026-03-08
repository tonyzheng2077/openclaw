import type { CommandHandler } from "./commands-types.js";
import { getProactivityService } from "../../proactivity/runtime.js";

const COMMIT_ID_RE = /^C-\d{4,}$/i;

type Parsed =
  | { ok: true; action: "done" | "cancel" | "block"; id: string }
  | { ok: true; action: "close-all" }
  | { ok: false; error: string }
  | null;

function parse(raw: string): Parsed {
  const t = raw.trim();
  if (!t.toLowerCase().startsWith("/commit")) {
    return null;
  }
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return {
      ok: false,
      error: "Usage: /commit done|cancel|block <C-xxxx> | /commit close-all confirm",
    };
  }
  const action = tokens[1]?.toLowerCase();
  if (action === "close-all") {
    if (tokens[2]?.toLowerCase() !== "confirm") {
      return {
        ok: false,
        error: "/commit close-all requires confirmation: /commit close-all confirm",
      };
    }
    return { ok: true, action: "close-all" };
  }
  if (action === "done" || action === "cancel" || action === "block") {
    const id = (tokens[2] ?? "").toUpperCase();
    if (!COMMIT_ID_RE.test(id)) {
      return { ok: false, error: "Commitment ID must look like C-xxxx" };
    }
    return { ok: true, action, id };
  }
  return {
    ok: false,
    error: "Usage: /commit done|cancel|block <C-xxxx> | /commit close-all confirm",
  };
}

export const handleCommitCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parse(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false, reply: { text: "❌ Unauthorized: /commit is restricted." } };
  }
  const svc = getProactivityService();
  if (!svc) {
    return { shouldContinue: false, reply: { text: "❌ Proactivity service is not running." } };
  }
  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  if (parsed.action === "close-all") {
    const count = await svc.closeAllOpenCommitments("manual-close-all");
    return { shouldContinue: false, reply: { text: `✅ Cancelled ${count} open commitment(s).` } };
  }

  const status =
    parsed.action === "done" ? "done" : parsed.action === "cancel" ? "cancelled" : "blocked";
  const ok = await svc.updateCommitmentStatus(parsed.id, status);
  return {
    shouldContinue: false,
    reply: { text: ok ? `✅ ${parsed.id} -> ${status}` : `❌ Commitment not found: ${parsed.id}` },
  };
};
