# Memory read middleware (Batch 2.3 runtime integration)

This documents the core runtime integration that enforces the pre-answer read gate on **live chat replies per turn**.

## What is enforced

When enabled, final outbound replies pass through `pre-answer-read-intercept` before send:

1. Calls interceptor contract at assistant pre-send boundary.
2. Blocks/transforms confident memory claims when `claim_gate.allowed=false`.
3. Requires `source_receipt_path` for memory-relevant replies.
4. Attaches per-reply metadata (`channelData.memoryRead`) with receipt/log paths.

## Activation

Edit your OpenClaw config (for example `~/.openclaw/config.json5`):

```json5
{
  memory: {
    readMiddleware: {
      enabled: true,
      mode: "hard_gate",
      command: "memory/system/hooks/pre-answer-read-interceptor.sh",
      timeoutMs: 15000,
      denyOnError: true,
      requireSourceReceipt: true,
      transformDeniedClaims: true,
    },
  },
}
```

Notes:

- `command` is resolved relative to the agent workspace unless absolute.
- `mode: "shadow"` keeps telemetry/metadata but does not block/transform replies.

## Rollback

Fast rollback (fully reversible):

```json5
{
  memory: {
    readMiddleware: {
      enabled: false,
    },
  },
}
```

Restart/reload OpenClaw runtime after config change.

## UAT: prove same prompt passes in a new session

Use the same memory-relevant prompt in two fresh sessions.

### Session A (baseline)

1. Start fresh session A.
2. Ask: `What do you remember about my default response style?`
3. Verify behavior:
   - No unsupported confident memory claim if retrieval/claim gate denies.
   - If miss, reply discloses miss (or safe fallback) rather than fabricated recall.

### Session B (new session, same prompt)

1. Start fresh session B.
2. Ask the exact same prompt.
3. Verify same gate behavior as session A.

### Evidence to capture

- `memory/system/logs/memory-read-decisions.jsonl` has one pre-answer event per turn.
- `channelData.memoryRead.sourceReceiptPath` present for memory-relevant allowed replies.
- If denied claim, outbound text is transformed to safe fallback.

Optional workspace verifier:

```bash
bash memory/system/verify/verify_live_path_gap_fix.sh
```

Expected terminal line:

```text
LIVE_PATH_GAP_FIX_VERIFY: PASS
```
