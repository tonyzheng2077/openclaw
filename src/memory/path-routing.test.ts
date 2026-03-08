import { describe, expect, it } from "vitest";
import { applyPathRouting } from "./path-routing.js";

describe("memory path routing", () => {
  const base = [
    {
      path: "memory/preferences/personality.md",
      startLine: 1,
      endLine: 2,
      score: 0.5,
      snippet: "pref",
      source: "memory" as const,
    },
    {
      path: "memory/random/chatter.md",
      startLine: 1,
      endLine: 2,
      score: 0.5,
      snippet: "noise",
      source: "memory" as const,
    },
  ];

  it("applies include/exclude filters", () => {
    const routed = applyPathRouting(base, {
      include: ["memory/preferences/**", "memory/projects/**"],
      exclude: ["**/random/**"],
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]?.path).toBe("memory/preferences/personality.md");
  });

  it("applies priority weights and reorders results", () => {
    const routed = applyPathRouting(base, {
      priority: [
        { pattern: "memory/random/**", weight: 0.4 },
        { pattern: "memory/preferences/**", weight: 2 },
      ],
    });
    expect(routed[0]?.path).toBe("memory/preferences/personality.md");
    expect(routed[0]?.score).toBeCloseTo(1);
    expect(routed[1]?.score).toBeCloseTo(0.2);
  });

  it("keeps behavior unchanged when routing is absent", () => {
    const routed = applyPathRouting(base, undefined);
    expect(routed).toEqual(base);
  });
});
