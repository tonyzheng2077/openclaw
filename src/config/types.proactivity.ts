export type ProactivitySeverity = "info" | "warn" | "critical";

export type ProactivityConfig = {
  enabled?: boolean;
  stateRoot?: string;
  assetsRoot?: string;
  owner?: string;
  report?: {
    mode?: "context" | "ops";
    channel?: string;
    opsChannelId?: string;
  };
  sla?: {
    defaultHours?: number;
  };
  reminder?: {
    atRiskThresholdHours?: number;
    blockedThresholdHours?: number;
    engineEnabled?: boolean;
  };
  heartbeat?: {
    intervalMinutes?: number;
    quietMode?: boolean;
    degradedModeWarnEveryHours?: number;
    dashboardAlways?: boolean;
  };
  consolidation?: {
    localTime?: string;
    quietMode?: boolean;
  };
  rollout?: {
    phase?: "shadow" | "warn_critical" | "full";
  };
  groupChat?: {
    redaction?: boolean;
  };
  queue?: {
    retryEveryMinutes?: number;
    maxAttempts?: number;
  };
  contracts?: {
    enabled?: boolean;
  };
};
