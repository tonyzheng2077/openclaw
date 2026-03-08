import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { MemorySearchResult } from "./types.js";

type PathRoutingConfig = ResolvedMemorySearchConfig["query"]["pathRouting"];

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").trim();
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*") {
      const next = normalized[i + 1];
      if (next === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += escapeRegExp(char);
  }
  out += "$";
  return new RegExp(out);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesAny(pathValue: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) {
    return false;
  }
  return patterns.some((pattern) => globToRegExp(pattern).test(pathValue));
}

function scoreWeight(
  pathValue: string,
  rules: Array<{ pattern: string; weight: number }> | undefined,
): number {
  if (!rules?.length) {
    return 1;
  }
  let weight = 1;
  for (const rule of rules) {
    if (globToRegExp(rule.pattern).test(pathValue)) {
      weight = rule.weight;
    }
  }
  return weight;
}

export function applyPathRouting<T extends MemorySearchResult>(
  results: T[],
  routing: PathRoutingConfig,
): T[] {
  if (!routing) {
    return results;
  }

  const weighted = results
    .filter((entry) => {
      const normalizedPath = normalizePath(entry.path);
      if (routing.include?.length && !matchesAny(normalizedPath, routing.include)) {
        return false;
      }
      if (routing.exclude?.length && matchesAny(normalizedPath, routing.exclude)) {
        return false;
      }
      return true;
    })
    .map((entry) => {
      const normalizedPath = normalizePath(entry.path);
      const weight = scoreWeight(normalizedPath, routing.priority);
      return {
        ...entry,
        score: entry.score * weight,
      };
    });

  return weighted.toSorted((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.path.localeCompare(b.path);
  });
}
