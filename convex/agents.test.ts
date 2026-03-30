import { describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

vi.mock("./lib/githubAccount", () => ({
  requireGitHubAccountAge: vi.fn(async () => undefined),
}));

const { publishAgentForUser, __test } = await import("./agents");

const AGENT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "USER.md",
  "openclaw.agent.json",
] as const;

type AgentFile = {
  path: string;
  size: number;
  storageId: Id<"_storage">;
  sha256: string;
  contentType?: string;
};

function makePublishFiles(overrides: Partial<Record<(typeof AGENT_FILES)[number], string>> = {}) {
  return AGENT_FILES.map((path) => ({
    path,
    size: 12,
    storageId: `storage:${path}` as Id<"_storage">,
    sha256: "a".repeat(64),
    contentType: path.endsWith(".json") ? "application/json" : "text/markdown",
    ...(overrides[path] ? { sha256: overrides[path] } : {}),
  })) as AgentFile[];
}

function makeManifestJson(
  overrides: Partial<{
    slug: string;
    displayName: string;
    summary: string;
    suggestedAgentId: string;
    skillDependencies: string[];
  }> = {},
) {
  return JSON.stringify({
    schemaVersion: 1,
    slug: "demo-agent",
    displayName: "Demo Agent",
    summary: "Helpful agent",
    suggestedAgentId: "demo-agent",
    skillDependencies: ["alpha-skill"],
    ...overrides,
  });
}

function makeCtx(options: {
  existing?: Doc<"agents"> | null;
  manifestJson?: string;
  mutationResult?: Id<"agents">;
}) {
  const storage = {
    get: vi.fn(async (storageId: Id<"_storage">) => {
      if (storageId !== ("storage:openclaw.agent.json" as Id<"_storage">)) return null;
      return new Blob([options.manifestJson ?? makeManifestJson()], {
        type: "application/json",
      });
    }),
  };
  const runQuery = vi.fn(async () => options.existing ?? null);
  const runMutation = vi.fn(async () => options.mutationResult ?? ("agents:new" as Id<"agents">));
  return {
    storage,
    runQuery,
    runMutation,
  } as unknown as ActionCtx & {
    storage: typeof storage;
    runQuery: typeof runQuery;
    runMutation: typeof runMutation;
  };
}

describe("agents publish helpers", () => {
  it("requires an exact allowlist of runtime files plus manifest", () => {
    expect(() =>
      __test.normalizeAgentFiles([
        ...makePublishFiles(),
        {
          path: "EXTRA.md",
          size: 1,
          storageId: "storage:extra" as Id<"_storage">,
          sha256: "b".repeat(64),
          contentType: "text/markdown",
        },
      ]),
    ).toThrow(/exactly/i);

    expect(() =>
      __test.normalizeAgentFiles(makePublishFiles().filter((file) => file.path !== "USER.md")),
    ).toThrow(/exactly/i);
  });

  it("rejects manifest payload mismatches", async () => {
    const ctx = makeCtx({
      manifestJson: makeManifestJson({ slug: "another-agent" }),
    });

    await expect(
      publishAgentForUser(ctx, "users:1" as Id<"users">, {
        slug: "demo-agent",
        displayName: "Demo Agent",
        summary: "Helpful agent",
        suggestedAgentId: "demo-agent",
        skillDependencies: ["alpha-skill"],
        files: makePublishFiles(),
      }),
    ).rejects.toThrow(/slug must match payload slug/i);
  });

  it("blocks overwrites from a different owner", async () => {
    const ctx = makeCtx({
      existing: {
        _id: "agents:existing",
        ownerUserId: "users:owner",
      } as Doc<"agents">,
    });

    await expect(
      publishAgentForUser(ctx, "users:actor" as Id<"users">, {
        slug: "demo-agent",
        displayName: "Demo Agent",
        summary: "Helpful agent",
        suggestedAgentId: "demo-agent",
        skillDependencies: ["alpha-skill"],
        files: makePublishFiles(),
      }),
    ).rejects.toThrow(/only the owner can publish agent updates/i);
  });

  it("updates the existing agent when the same owner republishes", async () => {
    const ctx = makeCtx({
      existing: {
        _id: "agents:existing",
        ownerUserId: "users:owner",
      } as Doc<"agents">,
      mutationResult: "agents:existing" as Id<"agents">,
    });

    await expect(
      publishAgentForUser(ctx, "users:owner" as Id<"users">, {
        slug: "demo-agent",
        displayName: "Demo Agent",
        summary: "Helpful agent",
        suggestedAgentId: "demo-agent",
        skillDependencies: ["alpha-skill"],
        files: makePublishFiles(),
      }),
    ).resolves.toEqual({ agentId: "agents:existing" });
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        existingAgentId: "agents:existing",
        slug: "demo-agent",
        suggestedAgentId: "demo-agent",
      }),
    );
  });
});
