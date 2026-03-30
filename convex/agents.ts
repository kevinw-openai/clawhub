import {
  AGENT_ALLOWED_FILES,
  AGENT_MANIFEST_FILENAME,
  type OpenClawAgentManifest,
  OpenClawAgentManifestSchema,
  parseArk,
} from "clawhub-schema";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, internalMutation, internalQuery, query } from "./functions";
import { requireUserFromAction } from "./lib/access";
import { requireGitHubAccountAge } from "./lib/githubAccount";
import { findOversizedPublishFile, getPublishFileSizeError, getPublishTotalSizeError, MAX_PUBLISH_TOTAL_BYTES } from "./lib/publishLimits";
import { toPublicAgent, toPublicUser } from "./lib/public";
import { isMacJunkPath, isTextFile, sanitizePath } from "./lib/skills";

const MAX_RAW_FILE_BYTES = 200 * 1024;
const MAX_LIST_LIMIT = 50;
const URL_SAFE_VALUE = /^[a-z0-9][a-z0-9-]*$/;

type AgentFile = Doc<"agents">["files"][number];

type PublishAgentArgs = {
  slug: string;
  displayName: string;
  summary: string;
  suggestedAgentId: string;
  skillDependencies?: string[];
  files: AgentFile[];
};

type PublishAgentResult = {
  agentId: Id<"agents">;
};

function normalizeSlugForLookup(slug: string) {
  return slug.trim().toLowerCase();
}

function normalizeUrlSafeValue(input: string, label: string) {
  const normalized = input.trim().toLowerCase();
  if (!URL_SAFE_VALUE.test(normalized)) {
    throw new ConvexError(`${label} must be lowercase and url-safe`);
  }
  return normalized;
}

function normalizeSummary(summary: string) {
  const normalized = summary.trim();
  if (!normalized) throw new ConvexError("Summary is required");
  return normalized;
}

function normalizeSkillDependencies(skillDependencies?: string[]) {
  const values = (skillDependencies ?? [])
    .map((entry) => normalizeUrlSafeValue(entry, "Skill dependency"))
    .filter(Boolean);
  return [...new Set(values)].sort();
}

function normalizeAgentFiles(files: AgentFile[]) {
  const normalized = files.map((file) => {
    const path = sanitizePath(file.path);
    if (!path) throw new ConvexError("Invalid file paths");
    return { ...file, path };
  });

  const filtered = normalized.filter((file) => !isMacJunkPath(file.path));
  if (filtered.some((file) => !isTextFile(file.path, file.contentType ?? undefined))) {
    throw new ConvexError("Only text-based files are allowed");
  }

  const oversizedFile = findOversizedPublishFile(filtered);
  if (oversizedFile) {
    throw new ConvexError(getPublishFileSizeError(oversizedFile.path));
  }

  const totalBytes = filtered.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_PUBLISH_TOTAL_BYTES) {
    throw new ConvexError(getPublishTotalSizeError("agent bundle"));
  }

  if (filtered.length !== AGENT_ALLOWED_FILES.length) {
    throw new ConvexError(
      `Agent bundles must include exactly: ${AGENT_ALLOWED_FILES.join(", ")}`,
    );
  }

  const allowed = new Set<string>(AGENT_ALLOWED_FILES);
  const provided = new Set<string>();
  for (const file of filtered) {
    if (!allowed.has(file.path)) {
      throw new ConvexError(
        `Unexpected file "${file.path}". Only ${AGENT_ALLOWED_FILES.join(", ")} are allowed`,
      );
    }
    provided.add(file.path);
  }

  for (const required of AGENT_ALLOWED_FILES) {
    if (!provided.has(required)) {
      throw new ConvexError(`Missing required file "${required}"`);
    }
  }

  return filtered.sort((left, right) => left.path.localeCompare(right.path));
}

async function readText(
  ctx: { storage: { get: (storageId: Id<"_storage">) => Promise<Blob | null> } },
  storageId: Id<"_storage">,
) {
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw new ConvexError("File missing in storage");
  return blob.text();
}

async function readManifest(
  ctx: { storage: { get: (storageId: Id<"_storage">) => Promise<Blob | null> } },
  files: AgentFile[],
) {
  const manifestFile = files.find((file) => file.path === AGENT_MANIFEST_FILENAME);
  if (!manifestFile) throw new ConvexError(`${AGENT_MANIFEST_FILENAME} is required`);
  const raw = await readText(ctx, manifestFile.storageId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ConvexError(`${AGENT_MANIFEST_FILENAME} must contain valid JSON`);
  }
  return parseArk(OpenClawAgentManifestSchema, parsed, AGENT_MANIFEST_FILENAME);
}

function assertManifestMatchesPayload(
  manifest: OpenClawAgentManifest,
  payload: {
    slug: string;
    displayName: string;
    summary: string;
    suggestedAgentId: string;
    skillDependencies: string[];
  },
) {
  if (manifest.slug !== payload.slug) {
    throw new ConvexError(`${AGENT_MANIFEST_FILENAME} slug must match payload slug`);
  }
  if (manifest.displayName !== payload.displayName) {
    throw new ConvexError(`${AGENT_MANIFEST_FILENAME} displayName must match payload displayName`);
  }
  if (manifest.summary !== payload.summary) {
    throw new ConvexError(`${AGENT_MANIFEST_FILENAME} summary must match payload summary`);
  }
  if (manifest.suggestedAgentId !== payload.suggestedAgentId) {
    throw new ConvexError(
      `${AGENT_MANIFEST_FILENAME} suggestedAgentId must match payload suggestedAgentId`,
    );
  }
  const manifestDependencies = normalizeSkillDependencies(manifest.skillDependencies);
  if (JSON.stringify(manifestDependencies) !== JSON.stringify(payload.skillDependencies)) {
    throw new ConvexError(
      `${AGENT_MANIFEST_FILENAME} skillDependencies must match payload skillDependencies`,
    );
  }
}

export async function publishAgentForUser(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: PublishAgentArgs,
): Promise<PublishAgentResult> {
  await requireGitHubAccountAge(ctx, userId);

  const slug = normalizeUrlSafeValue(args.slug, "Slug");
  const suggestedAgentId = normalizeUrlSafeValue(args.suggestedAgentId, "Suggested agent id");
  const displayName = args.displayName.trim();
  if (!displayName) throw new ConvexError("Display name required");
  const summary = normalizeSummary(args.summary);
  const skillDependencies = normalizeSkillDependencies(args.skillDependencies);
  const files = normalizeAgentFiles(args.files);
  const manifest = await readManifest(ctx, files);

  assertManifestMatchesPayload(manifest, {
    slug,
    displayName,
    summary,
    suggestedAgentId,
    skillDependencies,
  });

  const existing = (await ctx.runQuery(getAgentBySlugInternal, {
    slug,
  })) as Doc<"agents"> | null;
  const now = Date.now();

  if (existing && existing.ownerUserId !== userId) {
    throw new ConvexError("Only the owner can publish agent updates");
  }

  if (existing) {
    await ctx.runMutation(upsertAgentInternal, {
      existingAgentId: existing._id,
      userId,
      slug,
      displayName,
      summary,
      suggestedAgentId,
      skillDependencies,
      files,
      manifest,
      now,
    });
    return { agentId: existing._id };
  }

  const agentId = (await ctx.runMutation(upsertAgentInternal, {
    userId,
    slug,
    displayName,
    summary,
    suggestedAgentId,
    skillDependencies,
    files,
    manifest,
    now,
  })) as Id<"agents">;
  return { agentId };
}

const upsertAgentInternal = internalMutation({
  args: {
    existingAgentId: v.optional(v.id("agents")),
    userId: v.id("users"),
    slug: v.string(),
    displayName: v.string(),
    summary: v.string(),
    suggestedAgentId: v.string(),
    skillDependencies: v.array(v.string()),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id("_storage"),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
    manifest: v.object({
      schemaVersion: v.literal(1),
      slug: v.string(),
      displayName: v.string(),
      summary: v.string(),
      suggestedAgentId: v.string(),
      skillDependencies: v.optional(v.array(v.string())),
    }),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.deletedAt || user.deactivatedAt) throw new ConvexError("User not found");

    if (args.existingAgentId) {
      const existing = await ctx.db.get(args.existingAgentId);
      if (!existing) throw new ConvexError("Agent not found");
      await ctx.db.patch(existing._id, {
        displayName: args.displayName,
        summary: args.summary,
        suggestedAgentId: args.suggestedAgentId,
        skillDependencies: args.skillDependencies,
        files: args.files,
        manifest: args.manifest,
        softDeletedAt: undefined,
        updatedAt: args.now,
      });
      return existing._id;
    }

    return ctx.db.insert("agents", {
      slug: args.slug,
      displayName: args.displayName,
      summary: args.summary,
      suggestedAgentId: args.suggestedAgentId,
      skillDependencies: args.skillDependencies,
      ownerUserId: args.userId,
      ownerPublisherId: undefined,
      files: args.files,
      manifest: args.manifest,
      softDeletedAt: undefined,
      stats: { installs: 0 },
      createdAt: args.now,
      updatedAt: args.now,
    });
  },
});

export const getAgentBySlugInternal = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("agents")
      .withIndex("by_slug", (q) => q.eq("slug", normalizeSlugForLookup(args.slug)))
      .unique(),
});

export const getAgentByIdInternal = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => ctx.db.get(args.agentId),
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 24, MAX_LIST_LIMIT));
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_active_updated", (q) => q.eq("softDeletedAt", undefined))
      .order("desc")
      .take(limit);

    const items = await Promise.all(
      agents.map(async (agent) => ({
        agent: toPublicAgent(agent),
        owner: toPublicUser(await ctx.db.get(agent.ownerUserId)),
      })),
    );

    return items.filter(
      (item): item is { agent: NonNullable<typeof item.agent>; owner: typeof item.owner } =>
        Boolean(item.agent),
    );
  },
});

export const listPublicPage = query({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 24, MAX_LIST_LIMIT));
    const { page, isDone, continueCursor } = await ctx.db
      .query("agents")
      .withIndex("by_active_updated", (q) => q.eq("softDeletedAt", undefined))
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    const items = await Promise.all(
      page.map(async (agent) => ({
        agent: toPublicAgent(agent),
        owner: toPublicUser(await ctx.db.get(agent.ownerUserId)),
      })),
    );

    return {
      items: items.filter(
        (item): item is { agent: NonNullable<typeof item.agent>; owner: typeof item.owner } =>
          Boolean(item.agent),
      ),
      nextCursor: isDone ? null : continueCursor,
    };
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_slug", (q) => q.eq("slug", normalizeSlugForLookup(args.slug)))
      .unique();
    const publicAgent = toPublicAgent(agent);
    if (!publicAgent) return null;
    const owner = toPublicUser(await ctx.db.get(publicAgent.ownerUserId));
    return { agent: publicAgent, owner };
  },
});

export const getFileText = action({
  args: { agentId: v.id("agents"), path: v.string() },
  handler: async (ctx, args) => {
    const agent = (await ctx.runQuery(getAgentByIdInternal, {
      agentId: args.agentId,
    })) as Doc<"agents"> | null;
    if (!agent || agent.softDeletedAt) throw new ConvexError("Agent not found");

    const normalizedPath = args.path.trim();
    const normalizedLower = normalizedPath.toLowerCase();
    const file =
      agent.files.find((entry) => entry.path === normalizedPath) ??
      agent.files.find((entry) => entry.path.toLowerCase() === normalizedLower);
    if (!file) throw new ConvexError("File not found");
    if (file.size > MAX_RAW_FILE_BYTES) {
      throw new ConvexError("File exceeds 200KB limit");
    }

    const text = await readText(ctx, file.storageId);
    return { path: file.path, text, size: file.size, sha256: file.sha256 };
  },
});

export const publish = action({
  args: {
    slug: v.string(),
    displayName: v.string(),
    summary: v.string(),
    suggestedAgentId: v.string(),
    skillDependencies: v.optional(v.array(v.string())),
    files: v.array(
      v.object({
        path: v.string(),
        size: v.number(),
        storageId: v.id("_storage"),
        sha256: v.string(),
        contentType: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireUserFromAction(ctx);
    return publishAgentForUser(ctx, userId, args);
  },
});

export const __test = {
  normalizeSkillDependencies,
  normalizeAgentFiles,
  normalizeSlugForLookup,
  normalizeUrlSafeValue,
};
