/* @vitest-environment node */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalOpts } from "../types";

const mockRequireAuthToken = vi.fn(async () => "clh_test");
const mockGetOptionalAuthToken = vi.fn(async () => undefined);
vi.mock("../authToken.js", () => ({
  requireAuthToken: () => mockRequireAuthToken(),
  getOptionalAuthToken: () => mockGetOptionalAuthToken(),
}));

const mockGetRegistry = vi.fn(async () => "https://clawhub.ai");
vi.mock("../registry.js", () => ({
  getRegistry: (opts: unknown, params?: unknown) => mockGetRegistry(opts, params),
}));

const mockApiRequest = vi.fn();
const mockApiRequestForm = vi.fn();
const mockFetchText = vi.fn();
vi.mock("../../http.js", () => ({
  apiRequest: (registry: unknown, args: unknown, schema?: unknown) =>
    mockApiRequest(registry, args, schema),
  apiRequestForm: (registry: unknown, args: unknown, schema?: unknown) =>
    mockApiRequestForm(registry, args, schema),
  fetchText: (registry: unknown, args: unknown) => mockFetchText(registry, args),
  registryUrl: (path: string, registry: string) =>
    new URL(path.startsWith("/") ? path : `/${path}`, registry.endsWith("/") ? registry : `${registry}/`),
}));

const mockResolveOpenclawAgent = vi.fn();
const mockResolveOpenclawStateDir = vi.fn();
vi.mock("../clawdbotConfig.js", () => ({
  resolveOpenclawAgent: (agentId: string) => mockResolveOpenclawAgent(agentId),
  resolveOpenclawStateDir: () => mockResolveOpenclawStateDir(),
}));

const mockCmdInstallSkill = vi.fn();
vi.mock("./skills.js", () => ({
  cmdInstall: (...args: unknown[]) => mockCmdInstallSkill(...args),
}));

const mockSpawnSync = vi.fn();
vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

const mockFail = vi.fn((message: string) => {
  throw new Error(message);
});
const mockSpinner = {
  text: "",
  succeed: vi.fn(),
  fail: vi.fn(),
};
vi.mock("../ui.js", () => ({
  createSpinner: vi.fn(() => mockSpinner),
  fail: (message: string) => mockFail(message),
  formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const { AGENT_MANIFEST_FILENAME, AGENT_REQUIRED_MARKDOWN_FILES } = await import("../../schema/index.js");
const { cmdAgentExport, cmdAgentInstall, cmdAgentPublish } = await import("./agents.js");

function makeOpts(workdir: string): GlobalOpts {
  return {
    workdir,
    dir: join(workdir, "skills"),
    site: "https://clawhub.ai",
    registry: "https://clawhub.ai",
    registrySource: "default",
  };
}

async function makeTempRoot(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function writeAgentWorkspace(workspace: string) {
  await mkdir(workspace, { recursive: true });
  await Promise.all(
    AGENT_REQUIRED_MARKDOWN_FILES.map((fileName, index) =>
      writeFile(
        join(workspace, fileName),
        index === 0 ? "# Helpful Agent\n\nThis is a demo.\n" : `# ${fileName}\n`,
        "utf8",
      ),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpinner.text = "";
  mockRequireAuthToken.mockResolvedValue("clh_test");
  mockGetOptionalAuthToken.mockResolvedValue(undefined);
  mockGetRegistry.mockResolvedValue("https://clawhub.ai");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent commands", () => {
  it("exports the five runtime files and manifest from an OpenClaw workspace", async () => {
    const root = await makeTempRoot("clawhub-agent-export-");
    const workspace = join(root, "workspace-demo");
    const outputDir = join(root, "bundle");

    try {
      await writeAgentWorkspace(workspace);
      await writeFile(join(workspace, "HEARTBEAT.md"), "# ignored\n", "utf8");
      await mkdir(join(workspace, "skills", "alpha", ".clawhub"), { recursive: true });
      await mkdir(join(workspace, "skills", "beta", ".clawhub"), { recursive: true });
      await writeFile(
        join(workspace, "skills", "alpha", ".clawhub", "origin.json"),
        JSON.stringify({
          version: 1,
          registry: "https://clawhub.ai",
          slug: "alpha-skill",
          installedVersion: "1.0.0",
          installedAt: 123,
        }),
        "utf8",
      );
      await writeFile(
        join(workspace, "skills", "beta", ".clawhub", "origin.json"),
        JSON.stringify({
          version: 1,
          registry: "https://clawhub.ai",
          slug: "beta-skill",
          installedVersion: "2.0.0",
          installedAt: 456,
        }),
        "utf8",
      );

      mockResolveOpenclawAgent.mockResolvedValue({
        id: "demo-agent",
        name: "Demo Agent",
        workspace,
      });

      await cmdAgentExport(makeOpts(root), "demo-agent", { out: outputDir });

      const exportedFiles = (await readdir(outputDir)).sort();
      expect(exportedFiles).toEqual(
        [...AGENT_REQUIRED_MARKDOWN_FILES, AGENT_MANIFEST_FILENAME].sort(),
      );

      const manifest = JSON.parse(await readFile(join(outputDir, AGENT_MANIFEST_FILENAME), "utf8"));
      expect(manifest).toEqual({
        schemaVersion: 1,
        slug: "demo-agent",
        displayName: "Demo Agent",
        summary: "Helpful Agent",
        suggestedAgentId: "demo-agent",
        skillDependencies: ["alpha-skill", "beta-skill"],
      });
      await expect(readFile(join(outputDir, "HEARTBEAT.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes an agent bundle to the agents endpoint", async () => {
    const root = await makeTempRoot("clawhub-agent-publish-");
    const bundleDir = join(root, "bundle");

    try {
      await writeAgentWorkspace(bundleDir);
      await writeFile(
        join(bundleDir, AGENT_MANIFEST_FILENAME),
        `${JSON.stringify({
          schemaVersion: 1,
          slug: "demo-agent",
          displayName: "Demo Agent",
          summary: "Helpful Agent",
          suggestedAgentId: "demo-agent",
          skillDependencies: ["alpha-skill"],
        })}\n`,
        "utf8",
      );

      mockApiRequestForm.mockResolvedValue({ ok: true, agentId: "agents:1" });

      await cmdAgentPublish(makeOpts(root), bundleDir);

      expect(mockApiRequestForm).toHaveBeenCalledWith(
        "https://clawhub.ai",
        expect.objectContaining({
          method: "POST",
          path: "/api/v1/agents",
        }),
        expect.anything(),
      );

      const publishForm = mockApiRequestForm.mock.calls[0]?.[1]?.form as FormData;
      const payload = JSON.parse(String(publishForm.get("payload")));
      expect(payload).toEqual({
        slug: "demo-agent",
        displayName: "Demo Agent",
        summary: "Helpful Agent",
        suggestedAgentId: "demo-agent",
        skillDependencies: ["alpha-skill"],
      });
      const fileNames = publishForm
        .getAll("files")
        .map((file) => String((file as Blob & { name?: string }).name ?? ""))
        .sort();
      expect(fileNames).toEqual([...AGENT_REQUIRED_MARKDOWN_FILES, AGENT_MANIFEST_FILENAME].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects publish bundles with extra files", async () => {
    const root = await makeTempRoot("clawhub-agent-publish-extra-");
    const bundleDir = join(root, "bundle");

    try {
      await writeAgentWorkspace(bundleDir);
      await writeFile(
        join(bundleDir, AGENT_MANIFEST_FILENAME),
        `${JSON.stringify({
          schemaVersion: 1,
          slug: "demo-agent",
          displayName: "Demo Agent",
          summary: "Helpful Agent",
          suggestedAgentId: "demo-agent",
        })}\n`,
        "utf8",
      );
      await writeFile(join(bundleDir, "EXTRA.md"), "# nope\n", "utf8");

      await expect(cmdAgentPublish(makeOpts(root), bundleDir)).rejects.toThrow(
        /must contain exactly/i,
      );
      expect(mockApiRequestForm).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails install when the suggested agent id already exists locally", async () => {
    const root = await makeTempRoot("clawhub-agent-install-collision-");
    const stateDir = join(root, ".openclaw");

    try {
      mockResolveOpenclawStateDir.mockReturnValue(stateDir);
      mockApiRequest.mockResolvedValue({
        agent: {
          slug: "demo-agent",
          displayName: "Demo Agent",
          summary: "Helpful Agent",
          suggestedAgentId: "demo-agent",
          skillDependencies: [],
          files: AGENT_REQUIRED_MARKDOWN_FILES.map((path) => ({
            path,
            size: 10,
            sha256: "a".repeat(64),
            contentType: "text/markdown",
          })),
          stats: { installs: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
        owner: null,
      });
      mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
        if (args[0] === "agents" && args[1] === "list") {
          return { status: 0, stdout: '[{"id":"demo-agent"}]' };
        }
        return { status: 1, stderr: "unexpected" };
      });

      await expect(cmdAgentInstall(makeOpts(root), "demo-agent")).rejects.toThrow(
        /already exists/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs an agent, its files, and skill dependencies into OpenClaw", async () => {
    const root = await makeTempRoot("clawhub-agent-install-");
    const stateDir = join(root, ".openclaw");

    try {
      mockResolveOpenclawStateDir.mockReturnValue(stateDir);
      mockApiRequest.mockResolvedValue({
        agent: {
          slug: "demo-agent",
          displayName: "Demo Agent",
          summary: "Helpful Agent",
          suggestedAgentId: "demo-agent",
          skillDependencies: ["alpha-skill"],
          files: AGENT_REQUIRED_MARKDOWN_FILES.map((path) => ({
            path,
            size: 10,
            sha256: "a".repeat(64),
            contentType: "text/markdown",
          })),
          stats: { installs: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
        owner: null,
      });
      mockFetchText.mockImplementation(async (_registry: string, args: { url: string }) => {
        const url = new URL(args.url);
        return `# ${url.searchParams.get("path")}\n`;
      });
      mockSpawnSync.mockImplementation((_command: string, args: string[]) => {
        if (args[0] === "agents" && args[1] === "list") {
          return { status: 0, stdout: "[]" };
        }
        if (args[0] === "agents" && (args[1] === "add" || args[1] === "set-identity")) {
          return { status: 0, stdout: '{"ok":true}' };
        }
        return { status: 1, stderr: "unexpected" };
      });

      await cmdAgentInstall(makeOpts(root), "demo-agent");

      const workspaceDir = join(stateDir, "workspace-demo-agent");
      const agentsMd = await readFile(join(workspaceDir, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("# AGENTS.md");
      expect(mockCmdInstallSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          workdir: workspaceDir,
          dir: join(workspaceDir, "skills"),
        }),
        "alpha-skill",
        undefined,
        false,
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "openclaw",
        expect.arrayContaining([
          "agents",
          "add",
          "demo-agent",
          "--workspace",
          workspaceDir,
          "--agent-dir",
          join(stateDir, "agents", "demo-agent", "agent"),
        ]),
        expect.objectContaining({ encoding: "utf8" }),
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "openclaw",
        expect.arrayContaining([
          "agents",
          "set-identity",
          "--agent",
          "demo-agent",
          "--workspace",
          workspaceDir,
          "--from-identity",
        ]),
        expect.objectContaining({ encoding: "utf8" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
