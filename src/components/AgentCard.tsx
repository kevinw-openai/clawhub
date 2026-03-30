import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { PublicAgent, PublicUser } from "../lib/publicUser";

type AgentCardProps = {
  agent: PublicAgent;
  owner: PublicUser | null;
  meta: ReactNode;
};

export function AgentCard({ agent, owner, meta }: AgentCardProps) {
  return (
    <Link to="/agents/$slug" params={{ slug: agent.slug }} className="card skill-card">
      <div className="skill-card-tags">
        <div className="tag tag-compact">Agent</div>
        {owner?.handle ? <div className="tag">@{owner.handle}</div> : null}
      </div>
      <h3 className="skill-card-title">{agent.displayName}</h3>
      <p className="skill-card-summary">{agent.summary}</p>
      <div className="skill-card-footer">{meta}</div>
    </Link>
  );
}
