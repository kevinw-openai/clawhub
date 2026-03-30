import { CliAgentPublishRequestSchema, parseArk } from "clawhub-schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { publishAgentForUser } from "../agents";
import { requireApiTokenUser } from "../lib/apiTokenAuth";
import { applyRateLimit, parseBearerToken } from "../lib/httpRateLimit";
import { getPublishFileSizeError, MAX_PUBLISH_FILE_BYTES } from "../lib/publishLimits";
import { isMacJunkPath } from "../lib/skills";
import {
  MAX_RAW_FILE_BYTES,
  getPathSegments,
  json,
  safeTextFileResponse,
  text,
  toOptionalNumber,
} from "./shared";

type FileLike = {
  name: string;
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type FileLikeEntry = FormDataEntryValue & FileLike;

function toFileLike(entry: FormDataEntryValue): FileLikeEntry | null {
  if (typeof entry === "string") return null;
  const candidate = entry as Partial<FileLike>;
  if (typeof candidate.name !== "string") return null;
  if (typeof candidate.size !== "number") return null;
  if (typeof candidate.arrayBuffer !== "function") return null;
  return entry as FileLikeEntry;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseAgentPublishBody(body: unknown) {
  const parsed = parseArk(CliAgentPublishRequestSchema, body, "Agent publish payload");
  if (parsed.files.length === 0) throw new Error("files required");
  return {
    slug: parsed.slug,
    displayName: parsed.displayName,
    summary: parsed.summary,
    suggestedAgentId: parsed.suggestedAgentId,
    skillDependencies: parsed.skillDependencies?.length ? parsed.skillDependencies : undefined,
    files: parsed.files.map((file) => ({
      ...file,
      storageId: file.storageId as Id<"_storage">,
    })),
  };
}

async function parseAgentMultipartPublish(ctx: ActionCtx, request: Request) {
  const form = await request.formData();
  const payloadRaw = form.get("payload");
  if (!payloadRaw || typeof payloadRaw !== "string") {
    throw new Error("Missing payload");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON payload");
  }

  const files: Array<{
    path: string;
    size: number;
    storageId: Id<"_storage">;
    sha256: string;
    contentType?: string;
  }> = [];

  for (const entry of form.getAll("files")) {
    const file = toFileLike(entry);
    if (!file) continue;
    if (isMacJunkPath(file.name)) continue;
    if (file.size > MAX_PUBLISH_FILE_BYTES) {
      throw new Error(getPublishFileSizeError(file.name));
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    const storageId = await ctx.storage.store(file as Blob);
    files.push({
      path: file.name,
      size: file.size,
      storageId,
      sha256,
      contentType: file.type || undefined,
    });
  }

  return parseAgentPublishBody({
    slug: payload.slug,
    displayName: payload.displayName,
    summary: payload.summary,
    suggestedAgentId: payload.suggestedAgentId,
    skillDependencies: Array.isArray(payload.skillDependencies)
      ? payload.skillDependencies
      : undefined,
    files,
  });
}

export async function listAgentsV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const url = new URL(request.url);
  const limit = toOptionalNumber(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  const result = (await ctx.runQuery(api.agents.listPublicPage, {
    limit,
    cursor,
  })) as {
    items: Array<{
      agent: {
        slug: string;
        displayName: string;
        summary: string;
        suggestedAgentId: string;
        skillDependencies?: string[];
        stats: { installs: number };
        createdAt: number;
        updatedAt: number;
      };
      owner: { handle?: string; displayName?: string; image?: string } | null;
    }>;
    nextCursor: string | null;
  };

  return json(
    {
      items: result.items.map((item) => ({
        slug: item.agent.slug,
        displayName: item.agent.displayName,
        summary: item.agent.summary,
        suggestedAgentId: item.agent.suggestedAgentId,
        skillDependencies: item.agent.skillDependencies ?? [],
        stats: item.agent.stats,
        createdAt: item.agent.createdAt,
        updatedAt: item.agent.updatedAt,
        owner: item.owner
          ? {
              handle: item.owner.handle ?? null,
              displayName: item.owner.displayName ?? null,
              image: item.owner.image ?? null,
            }
          : null,
      })),
      nextCursor: result.nextCursor ?? null,
    },
    200,
    rate.headers,
  );
}

export async function agentsGetRouterV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "read");
  if (!rate.ok) return rate.response;

  const segments = getPathSegments(request, "/api/v1/agents/");
  if (segments.length === 0) return text("Missing slug", 400, rate.headers);
  const slug = segments[0]?.trim().toLowerCase() ?? "";
  const second = segments[1];

  if (segments.length === 1) {
    const result = (await ctx.runQuery(api.agents.getBySlug, { slug })) as
      | {
          agent: {
            _id: Id<"agents">;
            slug: string;
            displayName: string;
            summary: string;
            suggestedAgentId: string;
            skillDependencies?: string[];
            files: Array<{
              path: string;
              size: number;
              sha256: string;
              contentType?: string;
            }>;
            stats: { installs: number };
            createdAt: number;
            updatedAt: number;
          };
          owner: { handle?: string; displayName?: string; image?: string } | null;
        }
      | null;

    if (!result?.agent) return text("Agent not found", 404, rate.headers);

    return json(
      {
        agent: {
          slug: result.agent.slug,
          displayName: result.agent.displayName,
          summary: result.agent.summary,
          suggestedAgentId: result.agent.suggestedAgentId,
          skillDependencies: result.agent.skillDependencies ?? [],
          files: result.agent.files.map((file) => ({
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            contentType: file.contentType ?? null,
          })),
          stats: result.agent.stats,
          createdAt: result.agent.createdAt,
          updatedAt: result.agent.updatedAt,
        },
        owner: result.owner
          ? {
              handle: result.owner.handle ?? null,
              displayName: result.owner.displayName ?? null,
              image: result.owner.image ?? null,
            }
          : null,
      },
      200,
      rate.headers,
    );
  }

  if (second === "file" && segments.length === 2) {
    const path = new URL(request.url).searchParams.get("path")?.trim();
    if (!path) return text("Missing path", 400, rate.headers);

    const agent = (await ctx.runQuery(internal.agents.getAgentBySlugInternal, { slug })) as
      | {
          _id: Id<"agents">;
          files: Array<{
            path: string;
            size: number;
            sha256: string;
            storageId: Id<"_storage">;
            contentType?: string;
          }>;
        }
      | null;
    if (!agent) return text("Agent not found", 404, rate.headers);

    const normalized = path.trim();
    const normalizedLower = normalized.toLowerCase();
    const file =
      agent.files.find((entry) => entry.path === normalized) ??
      agent.files.find((entry) => entry.path.toLowerCase() === normalizedLower);
    if (!file) return text("File not found", 404, rate.headers);
    if (file.size > MAX_RAW_FILE_BYTES) return text("File exceeds 200KB limit", 413, rate.headers);

    const blob = await ctx.storage.get(file.storageId);
    if (!blob) return text("File missing in storage", 410, rate.headers);
    const textContent = await blob.text();

    return safeTextFileResponse({
      textContent,
      path: file.path,
      contentType: file.contentType ?? undefined,
      sha256: file.sha256,
      size: file.size,
      headers: rate.headers,
    });
  }

  return text("Not found", 404, rate.headers);
}

export async function publishAgentV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, "write");
  if (!rate.ok) return rate.response;

  try {
    if (!parseBearerToken(request)) return text("Unauthorized", 401, rate.headers);
  } catch {
    return text("Unauthorized", 401, rate.headers);
  }

  const { userId } = await requireApiTokenUser(ctx, request);
  const contentType = request.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const payload = parseAgentPublishBody(await request.json());
      const result = await publishAgentForUser(ctx, userId, payload);
      return json({ ok: true, ...result }, 200, rate.headers);
    }

    if (contentType.includes("multipart/form-data")) {
      const payload = await parseAgentMultipartPublish(ctx, request);
      const result = await publishAgentForUser(ctx, userId, payload);
      return json({ ok: true, ...result }, 200, rate.headers);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish failed";
    return text(message, 400, rate.headers);
  }

  return text("Unsupported content type", 415, rate.headers);
}
