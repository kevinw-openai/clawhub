import { AGENT_MANIFEST_FILENAME } from "clawhub-schema";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { PublicAgent, PublicUser } from "../lib/publicUser";
import { AgentFilesPanel } from "./AgentFilesPanel";

type AgentDetailPageProps = {
  slug: string;
};

type AgentBySlugResult = {
  agent: PublicAgent;
  owner: PublicUser | null;
} | null;

export function AgentDetailPage({ slug }: AgentDetailPageProps) {
  const result = useQuery(api.agents.getBySlug, { slug }) as AgentBySlugResult | undefined;

  if (result === undefined) {
    return (
      <main className="section">
        <div className="card">
          <div className="loading-indicator">Loading agent…</div>
        </div>
      </main>
    );
  }

  if (result === null || !result.agent) {
    return (
      <main className="section">
        <div className="card">Agent not found.</div>
      </main>
    );
  }

  const { agent, owner } = result;
  const runtimeFiles = agent.files.filter((file) => file.path !== AGENT_MANIFEST_FILENAME);

  return (
    <main className="section">
      <div className="skill-detail-stack">
        <div className="card skill-hero">
          <div className="skill-hero-header">
            <div className="skill-hero-title">
              <div className="skill-card-tags">
                <div className="tag tag-compact">Agent</div>
                <div className="tag tag-accent tag-compact">{agent.suggestedAgentId}</div>
              </div>
              <h1 className="section-title" style={{ margin: "8px 0 0" }}>
                {agent.displayName}
              </h1>
              <p className="section-subtitle">{agent.summary}</p>
              {owner?.handle ? (
                <div className="stat">
                  by <a href={`/u/${owner.handle}`}>@{owner.handle}</a>
                </div>
              ) : null}
            </div>
            <div className="skill-hero-cta">
              <div className="skill-version-pill">
                <span className="skill-version-label">Suggested id</span>
                <strong>{agent.suggestedAgentId}</strong>
              </div>
              <div className="skill-version-pill">
                <span className="skill-version-label">Installs</span>
                <strong>{agent.stats.installs}</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <h2 className="section-title" style={{ fontSize: "1.2rem", marginBottom: 8 }}>
            Install
          </h2>
          <pre className="file-viewer-code">{`clawhub agent install ${agent.slug}`}</pre>
          {(agent.skillDependencies ?? []).length > 0 ? (
            <p className="section-subtitle" style={{ marginTop: 12 }}>
              Includes skill dependencies: {(agent.skillDependencies ?? []).join(", ")}
            </p>
          ) : (
            <p className="section-subtitle" style={{ marginTop: 12 }}>
              No registry skill dependencies declared.
            </p>
          )}
        </div>

        <div className="card">
          <AgentFilesPanel agentId={agent._id} files={runtimeFiles} />
        </div>
      </div>
    </main>
  );
}
