/**
 * Phase 12 (UI review H5) — Brain hub landing page. Replaces the empty
 * force-graph that used to greet users and gives them a tour of what's
 * in the brain for the chosen org/project: counts, last activity,
 * recent thoughts, recent images, and a launcher into each tool.
 */

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useOrgProject, ORG_LEVEL } from "../../components/OrgProjectPicker";
import { LazyThumbnail } from "../../components/LazyThumbnail";
import { humanizeApiError } from "../../lib/humanize-error";
import { brainOverview, type BrainOverviewResponse } from "../../lib/brainApi";

const TOOL_TILES: ReadonlyArray<{
  to: string;
  label: string;
  description: string;
  accent: string;
  icon: () => React.ReactElement;
}> = [
  {
    to: "/brain/graph",
    label: "Graph",
    description: "Force-directed view of thoughts, entities, artifacts.",
    accent: "from-blue-500/20 to-blue-500/0",
    icon: GraphTileIcon,
  },
  {
    to: "/brain/timeline",
    label: "Timeline",
    description: "Chronological scroll across all captured artifacts.",
    accent: "from-purple-500/20 to-purple-500/0",
    icon: TimelineTileIcon,
  },
  {
    to: "/brain/search",
    label: "Search",
    description: "Hybrid lexical + semantic retrieval across the corpus.",
    accent: "from-emerald-500/20 to-emerald-500/0",
    icon: SearchTileIcon,
  },
  {
    to: "/brain/archive",
    label: "Archive",
    description: "Browse artifacts by kind, origin, or session.",
    accent: "from-slate-500/20 to-slate-500/0",
    icon: ArchiveTileIcon,
  },
  {
    to: "/brain/thoughts",
    label: "Thoughts",
    description: "Distilled notes, insights, decisions, questions.",
    accent: "from-amber-500/20 to-amber-500/0",
    icon: ThoughtTileIcon,
  },
  {
    to: "/brain/images",
    label: "Images",
    description: "Screenshots, diagrams, charts — with OCR & clustering.",
    accent: "from-pink-500/20 to-pink-500/0",
    icon: ImageTileIcon,
  },
  {
    to: "/brain/code",
    label: "Code",
    description: "Indexed symbols and file snapshots.",
    accent: "from-cyan-500/20 to-cyan-500/0",
    icon: CodeTileIcon,
  },
  {
    to: "/brain/compare",
    label: "Compare",
    description: "Diff two artifacts side-by-side.",
    accent: "from-indigo-500/20 to-indigo-500/0",
    icon: CompareTileIcon,
  },
  {
    to: "/brain/bookmarklet",
    label: "Capture",
    description: "Browser bookmarklet to add pages, snippets, screenshots.",
    accent: "from-orange-500/20 to-orange-500/0",
    icon: CaptureTileIcon,
  },
];

export function BrainHub(): React.ReactElement {
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState("");

  const { data, isLoading, error } = useQuery<BrainOverviewResponse>({
    queryKey: ["brain-overview", orgId, projectId],
    queryFn: () =>
      brainOverview({
        org_id: orgId,
        project_id: projectId !== ORG_LEVEL ? projectId : undefined,
        recent_limit: 6,
      }),
  });

  const errMessage = useMemo(
    () => (error ? humanizeApiError(error) : null),
    [error],
  );

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchInput.trim();
    if (!q) return;
    const params = new URLSearchParams({ org: orgId, project: projectId, q });
    navigate(`/brain/search?${params.toString()}`);
  };

  return (
    <div className="p-6 space-y-6 text-slate-200">
      {/* Hero / search */}
      <section className="bg-gradient-to-br from-slate-800/60 to-slate-900 border border-slate-800 rounded-xl p-6">
        <h1 className="text-2xl font-bold text-white">Brain</h1>
        <p className="text-sm text-slate-400 mt-1">
          What this project remembers — sessions, screenshots, decisions, code.
        </p>
        <form onSubmit={handleSearchSubmit} className="mt-4 flex gap-2 max-w-2xl">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search the brain — try “elasticsearch error”, “deploy script”, etc."
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={!searchInput.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Search
          </button>
        </form>
      </section>

      {/* Stats */}
      <section>
        <h2 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
          Corpus
        </h2>
        {errMessage ? (
          <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
            {errMessage}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard
              label="Artifacts"
              value={data?.counts.artifacts}
              loading={isLoading}
              to={`/brain/archive?org=${orgId}&project=${projectId}`}
              icon={<ArchiveTileIcon />}
            />
            <StatCard
              label="Thoughts"
              value={data?.counts.thoughts}
              loading={isLoading}
              to={`/brain/thoughts?org=${orgId}&project=${projectId}`}
              icon={<ThoughtTileIcon />}
            />
            <StatCard
              label="Images"
              value={data?.counts.images}
              loading={isLoading}
              to={`/brain/images?org=${orgId}&project=${projectId}`}
              icon={<ImageTileIcon />}
            />
            <StatCard
              label="Code blobs"
              value={data?.counts.code}
              loading={isLoading}
              to={`/brain/code?org=${orgId}&project=${projectId}`}
              icon={<CodeTileIcon />}
            />
            <StatCard
              label="Sessions"
              value={data?.counts.sessions}
              loading={isLoading}
              to="/"
              icon={<TimelineTileIcon />}
            />
          </div>
        )}
        {data?.last_artifact_ts && (
          <p className="text-xs text-slate-500 mt-2">
            Last activity {relativeTimeFromUnix(data.last_artifact_ts)}
          </p>
        )}
      </section>

      {/* Recent thoughts + recent images side by side on wide screens */}
      <div className="grid lg:grid-cols-2 gap-6">
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Recent thoughts
            </h2>
            <Link
              to={`/brain/thoughts?org=${orgId}&project=${projectId}`}
              className="text-xs text-blue-400 hover:underline"
            >
              all →
            </Link>
          </div>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-14 bg-slate-800/40 border border-slate-800 rounded-lg animate-pulse"
                />
              ))}
            </div>
          ) : data?.recent_thoughts.length ? (
            <ul className="space-y-2">
              {data.recent_thoughts.map((t) => (
                <li key={t.id}>
                  <Link
                    to={`/brain/thought/${encodeURIComponent(t.id)}?org_id=${orgId}`}
                    className="block bg-slate-800/40 border border-slate-800 rounded-lg p-3 hover:border-slate-600 transition-colors"
                  >
                    <div className="flex items-baseline gap-2 mb-1 text-xs">
                      <span className="font-mono bg-slate-900 px-1.5 py-0.5 rounded text-slate-400">
                        {t.thought_type ?? "?"}
                      </span>
                      <span className="text-slate-600 ml-auto">
                        {relativeTimeFromUnix(t.created_at)}
                      </span>
                    </div>
                    <p className="text-sm text-slate-300 line-clamp-2 leading-snug">
                      {t.content}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyHint>
              No thoughts yet. Capture some via the bookmarklet or your sessions.
            </EmptyHint>
          )}
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Recent images
            </h2>
            <Link
              to={`/brain/images?org=${orgId}&project=${projectId}`}
              className="text-xs text-blue-400 hover:underline"
            >
              all →
            </Link>
          </div>
          {isLoading ? (
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-square bg-slate-800/40 border border-slate-800 rounded animate-pulse"
                />
              ))}
            </div>
          ) : data?.recent_images.length ? (
            <div className="grid grid-cols-3 gap-2">
              {data.recent_images.map((img) => (
                <Link
                  key={img.hash}
                  to={`/brain/artifact/${img.hash}?org_id=${orgId}`}
                  title={img.caption ?? img.scene_class ?? img.hash}
                  className="block bg-slate-800/40 border border-slate-800 rounded overflow-hidden hover:border-slate-600 transition-colors"
                >
                  <LazyThumbnail
                    hash={img.hash}
                    orgId={orgId}
                    aspect="square"
                    fit="cover"
                    alt={img.caption ?? img.scene_class ?? img.hash}
                  />
                </Link>
              ))}
            </div>
          ) : (
            <EmptyHint>
              No images yet. Drop screenshots into a session or run image extractors.
            </EmptyHint>
          )}
        </section>
      </div>

      {/* Tool launcher */}
      <section>
        <h2 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
          Tools
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {TOOL_TILES.map((tile) => (
            <Link
              key={tile.to}
              to={`${tile.to}?org=${orgId}&project=${projectId}`}
              className={`relative bg-gradient-to-br ${tile.accent} bg-slate-800/40 border border-slate-800 rounded-lg p-4 hover:border-slate-600 hover:bg-slate-800/60 transition-colors`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-slate-300">
                  <tile.icon />
                </span>
                <span className="text-sm font-semibold text-white">{tile.label}</span>
              </div>
              <p className="text-xs text-slate-400 leading-snug">{tile.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  loading,
  to,
  icon,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  to: string;
  icon: React.ReactNode;
}): React.ReactElement {
  return (
    <Link
      to={to}
      className="group bg-slate-800/40 border border-slate-800 rounded-lg p-3 hover:border-slate-600 hover:bg-slate-800/60 transition-colors block"
    >
      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
        <span className="text-slate-400">{icon}</span>
        <span>{label}</span>
        <span className="ml-auto text-slate-700 group-hover:text-slate-400 transition-colors">
          →
        </span>
      </div>
      <div className="text-2xl font-semibold text-white tabular-nums" title={value?.toLocaleString()}>
        {loading ? (
          <span className="inline-block w-12 h-7 bg-slate-700/60 rounded animate-pulse" />
        ) : (
          formatCompact(value ?? 0)
        )}
      </div>
    </Link>
  );
}

/** 1234 → "1.2k", 12345 → "12k", 1234567 → "1.2M". Numbers under 1000
 *  render in full with grouping. The full value lives in the tile's
 *  title attribute for users who need exactness. */
function formatCompact(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

function EmptyHint({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="bg-slate-800/30 border border-slate-700/30 rounded-lg p-4 text-sm text-slate-500">
      {children}
    </div>
  );
}

function relativeTimeFromUnix(unixSec: number): string {
  const ms = Date.now() - unixSec * 1000;
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

// ── Tile icons ───────────────────────────────────────

function GraphTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <circle cx="6" cy="6" r="2" strokeWidth={1.6} />
      <circle cx="18" cy="6" r="2" strokeWidth={1.6} />
      <circle cx="12" cy="18" r="2" strokeWidth={1.6} />
      <path strokeLinecap="round" strokeWidth={1.6} d="M7.5 7.3l3.5 9M16.5 7.3l-3.5 9" />
    </svg>
  );
}
function TimelineTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M3 12h18M6 8v8m12-8v8" />
    </svg>
  );
}
function SearchTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <circle cx="11" cy="11" r="6" strokeWidth={1.6} />
      <path strokeLinecap="round" strokeWidth={1.6} d="M16 16l5 5" />
    </svg>
  );
}
function ArchiveTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M4 7h16v2H4V7zm1 4h14v9H5v-9zm5 3h4"
      />
    </svg>
  );
}
function ThoughtTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M9 12h6m-6 4h4M5 21l3-3h11a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z"
      />
    </svg>
  );
}
function ImageTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <rect x="3" y="5" width="18" height="14" rx="2" strokeWidth={1.6} />
      <circle cx="9" cy="11" r="1.5" strokeWidth={1.6} />
      <path strokeLinecap="round" strokeWidth={1.6} d="M3 17l5-4 4 3 3-2 6 5" />
    </svg>
  );
}
function CodeTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M8 6l-4 6 4 6M16 6l4 6-4 6"
      />
    </svg>
  );
}
function CompareTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeWidth={1.6} d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" />
    </svg>
  );
}
function CaptureTileIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M12 5v14M5 12h14"
      />
    </svg>
  );
}
