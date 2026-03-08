import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  readMiddleware?: MemoryReadMiddlewareConfig;
};

export type MemoryReadMiddlewareConfig = {
  /** Feature flag for Batch 2.3 runtime read-gate integration. */
  enabled?: boolean;
  /** hard_gate blocks/transforms replies; shadow only records metadata. */
  mode?: "hard_gate" | "shadow";
  /** Command/script to invoke for pre-answer read interception. */
  command?: string;
  /** Extra static args prepended before runtime args. */
  commandArgs?: string[];
  /** Interceptor timeout in milliseconds. */
  timeoutMs?: number;
  /** Deny reply when interceptor invocation/parse fails. */
  denyOnError?: boolean;
  /** Require source_receipt_path for memory-relevant replies. */
  requireSourceReceipt?: boolean;
  /** Transform denied confident claims into safe fallback text. */
  transformDeniedClaims?: boolean;
};

export type MemoryQmdConfig = {
  command?: string;
  searchMode?: MemoryQmdSearchMode;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
