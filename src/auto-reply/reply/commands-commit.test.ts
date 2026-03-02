import { describe, expect, it, vi } from "vitest";

const updateCommitmentStatus = vi.fn();
const closeAllOpenCommitments = vi.fn();

vi.mock("../../proactivity/runtime.js", () => ({
  getProactivityService: () => ({ updateCommitmentStatus, closeAllOpenCommitments }),
}));

import { handleCommitCommand } from "./commands-commit.js";

describe("/commit command", () => {
  it("handles done", async () => {
    updateCommitmentStatus.mockResolvedValueOnce(true);
    const res = await handleCommitCommand(
      {
        command: {
          commandBodyNormalized: "/commit done C-0001",
          isAuthorizedSender: true,
        },
      } as never,
      true,
    );
    expect(updateCommitmentStatus).toHaveBeenCalledWith("C-0001", "done");
    expect(res?.reply?.text).toContain("C-0001");
  });

  it("requires confirm for close-all", async () => {
    const res = await handleCommitCommand(
      {
        command: {
          commandBodyNormalized: "/commit close-all",
          isAuthorizedSender: true,
        },
      } as never,
      true,
    );
    expect(res?.reply?.text).toContain("requires confirmation");
  });

  it("executes close-all with confirm", async () => {
    closeAllOpenCommitments.mockResolvedValueOnce(3);
    const res = await handleCommitCommand(
      {
        command: {
          commandBodyNormalized: "/commit close-all confirm",
          isAuthorizedSender: true,
        },
      } as never,
      true,
    );
    expect(closeAllOpenCommitments).toHaveBeenCalled();
    expect(res?.reply?.text).toContain("3");
  });
});
