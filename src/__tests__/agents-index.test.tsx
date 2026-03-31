/* @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsIndex } from "../routes/agents/index";

const navigateMock = vi.fn();
let searchMock: Record<string, unknown> = {};
const useQueryMock = vi.fn();
const useActionMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (_config: { component: unknown; validateSearch: unknown }) => ({
    useNavigate: () => navigateMock,
    useSearch: () => searchMock,
  }),
  Link: (props: { children: ReactNode }) => <a href="/">{props.children}</a>,
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useAction: (...args: unknown[]) => useActionMock(...args),
}));

function makeAgent(slug: string, displayName: string, installs: number, ownerHandle?: string) {
  return {
    agent: {
      _id: `agents:${slug}`,
      _creationTime: 1,
      slug,
      displayName,
      summary: `${displayName} summary`,
      suggestedAgentId: slug,
      skillDependencies: [],
      ownerUserId: "users:1",
      ownerPublisherId: undefined,
      stats: { installs },
      createdAt: 1,
      updatedAt: installs,
      files: [],
    },
    owner: ownerHandle ? ({ handle: ownerHandle } as { handle: string }) : null,
  };
}

describe("AgentsIndex", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useQueryMock.mockReset();
    useActionMock.mockReset();
    useActionMock.mockReturnValue(vi.fn());
    searchMock = {};
  });

  it("renders an empty state when there are no agents", () => {
    useQueryMock.mockReturnValue([]);

    render(<AgentsIndex />);

    expect(screen.getByText("No agents match that filter.")).toBeTruthy();
  });

  it("renders agents and filters them by query", () => {
    useQueryMock.mockReturnValue([
      makeAgent("builder", "Builder", 5, "alice"),
      makeAgent("helper", "Helper", 2, "bob"),
    ]);

    render(<AgentsIndex />);

    expect(screen.getByText("Builder")).toBeTruthy();
    expect(screen.getByText("Helper")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Filter by name, slug, summary, or owner…"), {
      target: { value: "alice" },
    });

    expect(screen.getByText("Builder")).toBeTruthy();
    expect(screen.queryByText("Helper")).toBeNull();
    expect(navigateMock).toHaveBeenCalled();
  });
});
