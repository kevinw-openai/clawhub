import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { AgentCard } from "../../components/AgentCard";
import type { PublicAgent, PublicUser } from "../../lib/publicUser";

type AgentListEntry = {
  agent: PublicAgent;
  owner: PublicUser | null;
};

const sortKeys = ["newest", "updated", "installs", "name"] as const;
type SortKey = (typeof sortKeys)[number];
type SortDir = "asc" | "desc";

function parseSort(value: unknown): SortKey {
  if (typeof value !== "string") return "updated";
  if ((sortKeys as readonly string[]).includes(value)) return value as SortKey;
  return "updated";
}

function parseDir(value: unknown, sort: SortKey): SortDir {
  if (value === "asc" || value === "desc") return value;
  return sort === "name" ? "asc" : "desc";
}

export const Route = createFileRoute("/agents/")({
  validateSearch: (search) => ({
    q: typeof search.q === "string" && search.q.trim() ? search.q : undefined,
    sort: typeof search.sort === "string" ? parseSort(search.sort) : undefined,
    dir: search.dir === "asc" || search.dir === "desc" ? search.dir : undefined,
    view: search.view === "cards" || search.view === "list" ? search.view : undefined,
  }),
  component: AgentsIndex,
});

export function AgentsIndex() {
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const sort = search.sort ?? "updated";
  const dir = parseDir(search.dir, sort);
  const view = search.view ?? "list";
  const [query, setQuery] = useState(search.q ?? "");
  const items = useQuery(api.agents.list, { limit: 500 }) as AgentListEntry[] | undefined;
  const totalAgentsText =
    typeof items?.length === "number" ? items.length.toLocaleString("en-US") : null;

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const all = items ?? [];
    if (!normalized) return all;
    return all.filter((entry) => {
      if (entry.agent.slug.toLowerCase().includes(normalized)) return true;
      if (entry.agent.displayName.toLowerCase().includes(normalized)) return true;
      if (entry.agent.summary.toLowerCase().includes(normalized)) return true;
      return (entry.owner?.handle ?? "").toLowerCase().includes(normalized);
    });
  }, [items, query]);

  const sorted = useMemo(() => {
    const multiplier = dir === "asc" ? 1 : -1;
    const next = [...filtered];
    next.sort((left, right) => {
      switch (sort) {
        case "installs":
          return (left.agent.stats.installs - right.agent.stats.installs) * multiplier;
        case "name":
          return (
            (left.agent.displayName.localeCompare(right.agent.displayName) ||
              left.agent.slug.localeCompare(right.agent.slug)) * multiplier
          );
        case "newest":
          return (left.agent.createdAt - right.agent.createdAt) * multiplier;
        default:
          return (left.agent.updatedAt - right.agent.updatedAt) * multiplier;
      }
    });
    return next;
  }, [dir, filtered, sort]);

  return (
    <main className="section">
      <header className="skills-header-top">
        <h1 className="section-title" style={{ marginBottom: 8 }}>
          Agents
          {totalAgentsText && <span style={{ opacity: 0.55 }}>{` (${totalAgentsText})`}</span>}
        </h1>
        <p className="section-subtitle" style={{ marginBottom: 0 }}>
          {items === undefined ? "Loading agents…" : "Browse the agent library."}
        </p>
      </header>

      <div className="skills-container">
        <div className="skills-toolbar">
          <div className="skills-search">
            <input
              className="skills-search-input"
              value={query}
              onChange={(event) => {
                const next = event.target.value;
                const trimmed = next.trim();
                setQuery(next);
                void navigate({
                  search: (prev) => ({ ...prev, q: trimmed ? next : undefined }),
                  replace: true,
                });
              }}
              placeholder="Filter by name, slug, summary, or owner…"
            />
          </div>
          <div className="skills-toolbar-row">
            <select
              className="skills-sort"
              value={sort}
              onChange={(event) => {
                const nextSort = parseSort(event.target.value);
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    sort: nextSort,
                    dir: parseDir(prev.dir, nextSort),
                  }),
                  replace: true,
                });
              }}
              aria-label="Sort agents"
            >
              <option value="updated">Recently updated</option>
              <option value="newest">Newest</option>
              <option value="installs">Installs</option>
              <option value="name">Name</option>
            </select>
            <button
              className="skills-dir"
              type="button"
              aria-label={`Sort direction ${dir}`}
              onClick={() => {
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    dir: parseDir(prev.dir, sort) === "asc" ? "desc" : "asc",
                  }),
                  replace: true,
                });
              }}
            >
              {dir === "asc" ? "↑" : "↓"}
            </button>
            <button
              className={`skills-view${view === "cards" ? " is-active" : ""}`}
              type="button"
              onClick={() => {
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    view: prev.view === "cards" ? undefined : "cards",
                  }),
                  replace: true,
                });
              }}
            >
              {view === "cards" ? "List" : "Cards"}
            </button>
          </div>
        </div>

        {items === undefined ? (
          <div className="card">
            <div className="loading-indicator">Loading agents…</div>
          </div>
        ) : sorted.length === 0 ? (
          <div className="card">No agents match that filter.</div>
        ) : view === "cards" ? (
          <div className="grid">
            {sorted.map((entry) => (
              <AgentCard
                key={entry.agent._id}
                agent={entry.agent}
                owner={entry.owner}
                meta={
                  <div className="stat">
                    {entry.agent.stats.installs} installs
                    {entry.owner?.handle ? ` · @${entry.owner.handle}` : ""}
                  </div>
                }
              />
            ))}
          </div>
        ) : (
          <div className="skills-list">
            {sorted.map((entry) => (
              <Link
                key={entry.agent._id}
                className="skills-row"
                to="/agents/$slug"
                params={{ slug: entry.agent.slug }}
              >
                <div className="skills-row-main">
                  <div className="skills-row-title">
                    <span>{entry.agent.displayName}</span>
                    <span className="skills-row-slug">/{entry.agent.slug}</span>
                  </div>
                  <div className="skills-row-summary">{entry.agent.summary}</div>
                </div>
                <div className="skills-row-metrics">
                  <span className="stat">{entry.agent.stats.installs} installs</span>
                  {entry.owner?.handle ? <span className="stat">@{entry.owner.handle}</span> : null}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
