# Proactivity + Memory P0

This implementation adds a gateway-driven proactivity service (no SOUL dependency) with:

- Commitments ledger (`ledger.jsonl`) + audit events (`events.jsonl`)
- Snapshot writes (`snapshots/YYYY-MM-DD.json`)
- Reminder engine (at-risk / overdue / blocked)
- Nightly consolidation at local `02:00` (configurable) + startup catch-up
- 30m heartbeat/watchlist with delta dedupe + severity
- Unsent Discord notification queue + retry

## Paths

Runtime state (default):

- `~/.openclaw/state/proactivity/commitments/ledger.jsonl`
- `~/.openclaw/state/proactivity/commitments/events.jsonl`
- `~/.openclaw/state/proactivity/commitments/snapshots/*.json`
- `~/.openclaw/state/proactivity/watchlist/heartbeat_state.json`
- `~/.openclaw/state/proactivity/notifications/unsent-queue.jsonl`
- `~/.openclaw/state/proactivity/logs/{heartbeat,consolidation}/...`

Knowledge assets (default):

- `~/.openclaw/workspace/memory/daily/YYYY-MM-DD.md`
- `~/.openclaw/workspace/memory/MEMORY.md`
- (`projects` kept under assets root; consolidation input C deferred in P0)

## openclaw.json example

```json
{
  "proactivity": {
    "enabled": true,
    "stateRoot": "~/.openclaw/state/proactivity",
    "assetsRoot": "~/.openclaw/workspace/memory",
    "report": {
      "mode": "ops",
      "opsChannelId": "1477815403865571349"
    },
    "consolidation": {
      "localTime": "02:00",
      "quietMode": true
    },
    "heartbeat": {
      "intervalMinutes": 30,
      "quietMode": true,
      "degradedModeWarnEveryHours": 6
    },
    "sla": {
      "defaultHours": 24
    },
    "reminder": {
      "atRiskThresholdHours": 4,
      "blockedThresholdHours": 12
    },
    "queue": {
      "retryEveryMinutes": 5,
      "maxAttempts": 8
    },
    "rollout": {
      "phase": "full"
    },
    "groupChat": {
      "redaction": true
    }
  }
}
```

## Rollback switch

Set:

```json
{ "proactivity": { "enabled": false } }
```

Restart gateway to fully stop proactivity timers.
