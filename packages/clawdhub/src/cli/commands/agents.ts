import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { apiRequest, apiRequestForm, fetchText, registryUrl } from "../../http.js";
import {
  AGENT_ALLOWED_FILES,
  AGENT_MANIFEST_FILENAME,
  AGENT_REQUIRED_MARKDOWN_FILES,
  ApiRoutes,
  ApiV1AgentPublishResponseSchema,
  ApiV1AgentResponseSchema,
  OpenClawAgentManifestSchema,
  parseArk,
  type OpenClawAgentManifest,
} from "../../schema/index.js";
import { readSkillOrigin } from "../../skills.js";
import { getOptionalAuthToken, requireAuthToken } from "../authToken.js";
import { resolveOpenclawAgent, resolveOpenclawStateDir } from "../clawdbotConfig.js";
import { getRegistry } from "../registry.js";
import { sanitizeSlug, titleCase } from "../slug.js";
import type { GlobalOpts } from "../types.js";
import { createSpinner, fail, formatError } from "../ui.js";
import { cmdInstall as cmdInstallSkill } from "./skills.js";

const URL_SAFE_VALUE = /^[a-z0-9][a-z0-9-]*$/;

function normalizeSlashPath(value: string) {
  return value.split(sep).join("/");
}

function normalizeAgentIdOrFail(value: string, label = "Agent id") {
  const normalized = value.trim().toLowerCase();
  if (!URL_SAFE_VALUE.test(normalized)) {
    fail(`${label} must be lowercase and url-safe`);
  }
  return normalized;
}

function normalizeAgentSlugOrFail(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!URL_SAFE_VALUE.test(normalized)) {
    fail("Slug must be lowercase and url-safe");
  }
  return normalized;
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listBundlePaths(root: string) {
  const files: string[] = [];
  const absRoot = resolve(root);

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(normalizeSlashPath(relative(absRoot, full)));
    }
  }

  await walk(absRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

async function readAgentManifest(path: string): Promise<OpenClawAgentManifest> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail(`${AGENT_MANIFEST_FILENAME} must contain valid JSON`);
  }
  return parseArk(OpenClawAgentManifestSchema, parsed, AGENT_MANIFEST_FILENAME);
}

async function readAgentBundle(folder: string) {
  const bundlePaths = await listBundlePaths(folder);
  const expected = [...AGENT_ALLOWED_FILES].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(bundlePaths) !== JSON.stringify(expected)) {
    fail(`Agent bundles must contain exactly: ${expected.join(", ")}`);
  }

  const files = await Promise.all(
    bundlePaths.map(async (relPath) => {
      const absPath = join(folder, relPath);
      const bytes = new Uint8Array(await readFile(absPath));
      return {
        relPath,
        absPath,
        bytes,
      };
    }),
  );

  const manifestPath = join(folder, AGENT_MANIFEST_FILENAME);
  const manifest = await readAgentManifest(manifestPath);
  return { files, manifest };
}

function deriveSummary(markdownFiles: Record<string, string>, fallbackName: string) {
  for (const fileName of ["AGENTS.md", "SOUL.md"]) {
    const content = markdownFiles[fileName];
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const raw of lines) {
      const trimmed = raw.trim().replace(/^#+\s*/, "");
      if (!trimmed) continue;
      return trimmed.length > 160 ? `${trimmed.slice(0, 157).trimEnd()}...` : trimmed;
    }
  }
  return `${fallbackName} agent bundle`;
}

async function collectInstalledSkillDependencies(workspace: string) {
  const skillsDir = join(workspace, "skills");
  if (!(await pathExists(skillsDir))) return [];
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const slugs = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const origin = await readSkillOrigin(join(skillsDir, entry.name));
    if (!origin?.slug) continue;
    slugs.add(origin.slug.trim().toLowerCase());
  }
  return [...slugs].sort();
}

function parseJsonFromCommand(stdout: string) {
  const trimmed = stdout.trim();
  const firstObject = trimmed.indexOf("{");
  const firstArray = trimmed.indexOf("[");
  const start =
    firstArray === -1 ? firstObject : firstObject === -1 ? firstArray : Math.min(firstArray, firstObject);
  if (start === -1) fail("Command did not return JSON output");
  return JSON.parse(trimmed.slice(start)) as unknown;
}

function runOpenClaw(args: string[]) {
  const result = spawnSync("openclaw", args, { encoding: "utf8" });
  if (result.status === 0) return result.stdout ?? "";
  const message = result.stderr?.trim() || result.stdout?.trim() || `openclaw ${args.join(" ")}`;
  throw new Error(message);
}

function listInstalledOpenClawAgentIds() {
  const output = runOpenClaw(["agents", "list", "--json"]);
  const parsed = parseJsonFromCommand(output);
  if (!Array.isArray(parsed)) return new Set<string>();
  return new Set(
    parsed
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
          ? String((entry as { id: string }).id).trim()
          : "",
      )
      .filter(Boolean),
  );
}

function isOptionalIdentitySyncError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /no identity data found/i.test(message) && /identity\.md/i.test(message);
}

export async function cmdAgentExport(
  _opts: GlobalOpts,
  rawAgentId: string,
  options: { out?: string } = {},
) {
  const agentId = normalizeAgentIdOrFail(rawAgentId);
  const agent = await resolveOpenclawAgent(agentId);
  if (!agent?.workspace) fail(`OpenClaw agent not found: ${agentId}`);

  const outputDir = resolve(process.cwd(), options.out?.trim() || sanitizeSlug(agentId));
  if (await pathExists(outputDir)) fail(`Output path already exists: ${outputDir}`);

  const spinner = createSpinner(`Exporting ${agentId}`);
  try {
    const markdownFiles: Record<string, string> = {};
    for (const fileName of AGENT_REQUIRED_MARKDOWN_FILES) {
      const sourcePath = join(agent.workspace, fileName);
      if (!(await pathExists(sourcePath))) {
        fail(`Missing required file in workspace: ${sourcePath}`);
      }
      markdownFiles[fileName] = await readFile(sourcePath, "utf8");
    }

    const displayName = agent.name?.trim() || titleCase(agentId);
    const summary = deriveSummary(markdownFiles, displayName);
    const skillDependencies = await collectInstalledSkillDependencies(agent.workspace);
    const manifest = {
      schemaVersion: 1 as const,
      slug: normalizeAgentSlugOrFail(agentId),
      displayName,
      summary,
      suggestedAgentId: agentId,
      ...(skillDependencies.length > 0 ? { skillDependencies } : {}),
    };

    await mkdir(outputDir, { recursive: true });
    for (const [fileName, content] of Object.entries(markdownFiles)) {
      await writeFile(join(outputDir, fileName), content, "utf8");
    }
    await writeFile(
      join(outputDir, AGENT_MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    spinner.succeed(`Exported ${agentId} -> ${outputDir}`);
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdAgentPublish(opts: GlobalOpts, folderArg: string) {
  const folder = resolve(opts.workdir, folderArg);
  const folderStat = await stat(folder).catch(() => null);
  if (!folderStat || !folderStat.isDirectory()) fail("Path must be a folder");

  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createSpinner(`Preparing ${basename(folder)}`);

  try {
    const { files, manifest } = await readAgentBundle(folder);
    const form = new FormData();
    form.set(
      "payload",
      JSON.stringify({
        slug: manifest.slug,
        displayName: manifest.displayName,
        summary: manifest.summary,
        suggestedAgentId: manifest.suggestedAgentId,
        ...(manifest.skillDependencies?.length
          ? { skillDependencies: manifest.skillDependencies }
          : {}),
      }),
    );

    let index = 0;
    for (const file of files) {
      index += 1;
      spinner.text = `Uploading ${file.relPath} (${index}/${files.length})`;
      const blob = new Blob([Buffer.from(file.bytes)], {
        type: file.relPath.endsWith(".json") ? "application/json" : "text/markdown",
      });
      form.append("files", blob, file.relPath);
    }

    spinner.text = `Publishing ${manifest.slug}`;
    await apiRequestForm(
      registry,
      { method: "POST", path: ApiRoutes.agents, token, form },
      ApiV1AgentPublishResponseSchema,
    );

    spinner.succeed(`OK. Published ${manifest.slug}`);
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export async function cmdAgentInstall(
  opts: GlobalOpts,
  rawSlug: string,
  options: { id?: string } = {},
) {
  const slug = normalizeAgentSlugOrFail(rawSlug);
  const token = await getOptionalAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const spinner = createSpinner(`Fetching ${slug}`);

  try {
    const result = await apiRequest(
      registry,
      { method: "GET", path: `${ApiRoutes.agents}/${encodeURIComponent(slug)}`, token },
      ApiV1AgentResponseSchema,
    );
    if (!result.agent) fail(`Agent not found: ${slug}`);

    const agentId = normalizeAgentIdOrFail(options.id ?? result.agent.suggestedAgentId, "Agent id");
    const installedAgentIds = listInstalledOpenClawAgentIds();
    if (installedAgentIds.has(agentId)) {
      fail(`OpenClaw agent "${agentId}" already exists. Re-run with --id to choose another id.`);
    }

    const openclawStateDir = resolveOpenclawStateDir();
    const workspaceDir = join(openclawStateDir, `workspace-${agentId}`);
    if (await pathExists(workspaceDir)) {
      fail(`Workspace already exists: ${workspaceDir}`);
    }

    spinner.text = `Creating workspace ${agentId}`;
    await mkdir(workspaceDir, { recursive: true });

    for (const fileName of AGENT_REQUIRED_MARKDOWN_FILES) {
      const url = registryUrl(`${ApiRoutes.agents}/${encodeURIComponent(slug)}/file`, registry);
      url.searchParams.set("path", fileName);
      spinner.text = `Downloading ${fileName}`;
      const content = await fetchText(registry, { url: url.toString(), token });
      await writeFile(join(workspaceDir, fileName), content, "utf8");
    }

    for (const dependency of result.agent.skillDependencies ?? []) {
      spinner.text = `Installing skill ${dependency}`;
      await cmdInstallSkill(
        {
          ...opts,
          workdir: workspaceDir,
          dir: join(workspaceDir, "skills"),
        },
        dependency,
        undefined,
        false,
      );
    }

    const agentDir = join(openclawStateDir, "agents", agentId, "agent");
    spinner.text = `Registering OpenClaw agent ${agentId}`;
    runOpenClaw([
      "agents",
      "add",
      agentId,
      "--workspace",
      workspaceDir,
      "--agent-dir",
      agentDir,
      "--non-interactive",
      "--json",
    ]);
    let skippedIdentitySync = false;
    try {
      runOpenClaw([
        "agents",
        "set-identity",
        "--agent",
        agentId,
        "--workspace",
        workspaceDir,
        "--from-identity",
        "--json",
      ]);
    } catch (error) {
      if (!isOptionalIdentitySyncError(error)) throw error;
      skippedIdentitySync = true;
    }

    spinner.succeed(`Installed ${slug} as OpenClaw agent "${agentId}"`);
    if (skippedIdentitySync) {
      console.log(
        `Note: skipped OpenClaw identity sync because ${join("~", ".openclaw", `workspace-${agentId}`, "IDENTITY.md")} does not contain structured identity fields yet.`,
      );
    }
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

export const __test = {
  collectInstalledSkillDependencies,
  deriveSummary,
  listBundlePaths,
  normalizeAgentIdOrFail,
  normalizeAgentSlugOrFail,
  parseJsonFromCommand,
  readAgentBundle,
  isOptionalIdentitySyncError,
};
