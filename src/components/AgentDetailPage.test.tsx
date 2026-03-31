/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicAgent, PublicUser } from "../lib/publicUser";
import { AgentDetailPage } from "./AgentDetailPage";

const useQueryMock = vi.fn();
const useActionMock = vi.fn();
const agentFilesPanelMock = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useAction: (...args: unknown[]) => useActionMock(...args),
}));

vi.mock("./AgentFilesPanel", () => ({
  AgentFilesPanel: (props: unknown) => {
    agentFilesPanelMock(props);
    const files = (props as { files: Array<{ path: string }> }).files;
    return <div data-testid="agent-files">{files.map((file) => file.path).join(",")}</div>;
  },
}));

function makeAgent(
  overrides: Partial<PublicAgent> = {},
  owner: PublicUser | null = { handle: "alice" } as PublicUser,
) {
  return {
    agent: {
      _id: "agents:1",
      _creationTime: 1,
      slug: "demo-agent",
      displayName: "Demo Agent",
      summary: "Helpful agent",
      suggestedAgentId: "demo-agent",
      skillDependencies: ["alpha-skill"],
      ownerUserId: "users:1",
      ownerPublisherId: undefined,
      stats: { installs: 4 },
      createdAt: 1,
      updatedAt: 2,
      files: [
        { path: "AGENTS.md", size: 10, sha256: "a".repeat(64), contentType: "text/markdown" },
        {
          path: "openclaw.agent.json",
          size: 10,
          sha256: "m".repeat(64),
          contentType: "application/json",
        },
      ],
      ...overrides,
    } as PublicAgent,
    owner,
  };
}

describe("AgentDetailPage", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useActionMock.mockReset();
    useActionMock.mockReturnValue(vi.fn());
    agentFilesPanelMock.mockReset();
  });

  it("renders install instructions and hides the manifest from the files panel", () => {
    useQueryMock.mockReturnValue(makeAgent());

    render(<AgentDetailPage slug="demo-agent" />);

    expect(screen.getByText("Demo Agent")).toBeTruthy();
    expect(screen.getByText("clawhub agent install demo-agent")).toBeTruthy();
    expect(screen.getByTestId("agent-files").textContent).toBe("AGENTS.md");
    expect(agentFilesPanelMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        files: [{ path: "AGENTS.md", size: 10, sha256: "a".repeat(64), contentType: "text/markdown" }],
      }),
    );
  });

  it("renders a not found state", () => {
    useQueryMock.mockReturnValue(null);

    render(<AgentDetailPage slug="missing-agent" />);

    expect(screen.getByText("Agent not found.")).toBeTruthy();
  });

  it("renders a loading state while the query is pending", () => {
    useQueryMock.mockReturnValue(undefined);

    render(<AgentDetailPage slug="loading-agent" />);

    expect(screen.getByText("Loading agent…")).toBeTruthy();
  });
});
