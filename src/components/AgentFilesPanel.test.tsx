/* @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { AgentFilesPanel } from "./AgentFilesPanel";

const getFileTextMock = vi.fn();

vi.mock("convex/react", () => ({
  useAction: () => getFileTextMock,
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

const files = [
  { path: "USER.md", size: 10, sha256: "u".repeat(64), contentType: "text/markdown" },
  { path: "TOOLS.md", size: 10, sha256: "t".repeat(64), contentType: "text/markdown" },
  { path: "AGENTS.md", size: 10, sha256: "a".repeat(64), contentType: "text/markdown" },
  { path: "SOUL.md", size: 10, sha256: "s".repeat(64), contentType: "text/markdown" },
  { path: "IDENTITY.md", size: 10, sha256: "i".repeat(64), contentType: "text/markdown" },
];

describe("AgentFilesPanel", () => {
  beforeEach(() => {
    getFileTextMock.mockReset();
  });

  it("loads AGENTS.md first and switches between runtime files", async () => {
    getFileTextMock.mockImplementation(async ({ path }: { path: string }) => ({
      text: `# ${path}`,
      size: 10,
      sha256: path.slice(0, 1).repeat(64),
    }));

    render(
      <AgentFilesPanel
        agentId={"agents:1" as Id<"agents">}
        files={files}
      />,
    );

    await screen.findByText("# AGENTS.md");
    expect(getFileTextMock).toHaveBeenCalledWith({
      agentId: "agents:1",
      path: "AGENTS.md",
    });

    fireEvent.click(screen.getByRole("button", { name: /USER\.md/i }));
    await screen.findByText("# USER.md");
    expect(getFileTextMock).toHaveBeenCalledWith({
      agentId: "agents:1",
      path: "USER.md",
    });
  });

  it("ignores stale responses after switching files", async () => {
    const resolvers: Record<
      string,
      (value: { text: string; size: number; sha256: string }) => void
    > = {};

    getFileTextMock.mockImplementation(
      ({ path }: { path: string }) =>
        new Promise<{ text: string; size: number; sha256: string }>((resolve) => {
          resolvers[path] = resolve;
        }),
    );

    render(
      <AgentFilesPanel
        agentId={"agents:1" as Id<"agents">}
        files={files}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /SOUL\.md/i }));
    fireEvent.click(screen.getByRole("button", { name: /TOOLS\.md/i }));

    resolvers["SOUL.md"]({ text: "# SOUL.md", size: 10, sha256: "s".repeat(64) });
    resolvers["TOOLS.md"]({ text: "# TOOLS.md", size: 10, sha256: "t".repeat(64) });

    await screen.findByText("# TOOLS.md");
    expect(screen.queryByText("# SOUL.md")).toBeNull();
  });

  it("caches fetched files and avoids duplicate requests", async () => {
    getFileTextMock.mockImplementation(async ({ path }: { path: string }) => ({
      text: `# ${path}`,
      size: 10,
      sha256: path.slice(0, 1).repeat(64),
    }));

    render(
      <AgentFilesPanel
        agentId={"agents:1" as Id<"agents">}
        files={files}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /TOOLS\.md/i }));
    await screen.findByText("# TOOLS.md");

    fireEvent.click(screen.getByRole("button", { name: /AGENTS\.md/i }));
    await screen.findByText("# AGENTS.md");
    fireEvent.click(screen.getByRole("button", { name: /TOOLS\.md/i }));

    await waitFor(() => {
      const toolCalls = getFileTextMock.mock.calls.filter(
        ([args]) => (args as { path?: string }).path === "TOOLS.md",
      );
      expect(toolCalls).toHaveLength(1);
    });
  });
});
