import { AGENT_REQUIRED_MARKDOWN_FILES } from "clawhub-schema";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { formatBytes } from "./skillDetailUtils";

type AgentFile = {
  path: string;
  size: number;
  sha256: string;
  contentType?: string;
};

type AgentFilesPanelProps = {
  agentId: Id<"agents">;
  files: AgentFile[];
};

function orderAgentFiles(files: AgentFile[]) {
  const order = new Map(AGENT_REQUIRED_MARKDOWN_FILES.map((path, index) => [path, index]));
  return [...files].sort((left, right) => {
    const leftIndex = order.get(left.path) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right.path) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.path.localeCompare(right.path);
  });
}

export function AgentFilesPanel({ agentId, files }: AgentFilesPanelProps) {
  const getFileText = useAction(api.agents.getFileText);
  const orderedFiles = orderAgentFiles(files);
  const [selectedPath, setSelectedPath] = useState<string>(orderedFiles[0]?.path ?? "AGENTS.md");
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileMeta, setFileMeta] = useState<{ size: number; sha256: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestId = useRef(0);
  const fileCache = useRef(new Map<string, { text: string; size: number; sha256: string }>());

  useEffect(() => {
    if (orderedFiles.length === 0) return;
    setSelectedPath((current) =>
      orderedFiles.some((file) => file.path === current) ? current : orderedFiles[0]?.path ?? current,
    );
  }, [orderedFiles]);

  useEffect(() => {
    if (!selectedPath) return;
    const cacheKey = `${agentId}:${selectedPath}`;
    const cached = fileCache.current.get(cacheKey);
    requestId.current += 1;
    const currentRequest = requestId.current;

    if (cached) {
      setFileContent(cached.text);
      setFileMeta({ size: cached.size, sha256: cached.sha256 });
      setFileError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setFileError(null);
    setFileContent(null);
    setFileMeta(null);

    void getFileText({ agentId, path: selectedPath })
      .then((data) => {
        if (requestId.current !== currentRequest) return;
        fileCache.current.set(cacheKey, data);
        setFileContent(data.text);
        setFileMeta({ size: data.size, sha256: data.sha256 });
        setIsLoading(false);
      })
      .catch((error) => {
        if (requestId.current !== currentRequest) return;
        setFileError(error instanceof Error ? error.message : "Failed to load file");
        setIsLoading(false);
      });
  }, [agentId, getFileText, selectedPath]);

  return (
    <div className="file-browser">
      <div className="file-list">
        <div className="file-list-header">
          <h2 className="section-title" style={{ fontSize: "1.05rem", margin: 0 }}>
            Files
          </h2>
          <span className="section-subtitle" style={{ margin: 0 }}>
            {orderedFiles.length} runtime files
          </span>
        </div>
        <div className="file-list-body">
          {orderedFiles.map((file) => (
            <button
              key={file.path}
              className={`file-row file-row-button${selectedPath === file.path ? " is-active" : ""}`}
              type="button"
              onClick={() => setSelectedPath(file.path)}
              aria-current={selectedPath === file.path ? "true" : undefined}
            >
              <span className="file-path">{file.path}</span>
              <span className="file-meta">{formatBytes(file.size)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="file-viewer">
        <div className="file-viewer-header">
          <div className="file-path">{selectedPath}</div>
          {fileMeta ? (
            <span className="file-meta">
              {formatBytes(fileMeta.size)} · {fileMeta.sha256.slice(0, 12)}…
            </span>
          ) : null}
        </div>
        <div className="file-viewer-body markdown">
          {isLoading ? (
            <div className="stat">Loading…</div>
          ) : fileError ? (
            <div className="stat">Failed to load file: {fileError}</div>
          ) : fileContent ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent}</ReactMarkdown>
          ) : (
            <div className="stat">Select a file to preview.</div>
          )}
        </div>
      </div>
    </div>
  );
}
