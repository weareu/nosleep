import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  apiFetch,
  fetchOrgs,
  fetchProjects,
  fetchStrategyTree,
  fetchStrategyNode,
  createTree,
  getNextActionable,
  type OrgWithStats,
  type ProjectRow,
} from "../lib/api";
import type {
  StrategyTree,
  StrategyNodeWithMetrics,
} from "@nosleep/shared";
import { StrategyTreeView } from "../components/StrategyTreeView";
import { StrategyNodeDetail } from "../components/StrategyNodeDetail";

export function StrategyPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showCreateTree, setShowCreateTree] = useState(false);
  const [createTreeJson, setCreateTreeJson] = useState("");
  const [createTreeErr, setCreateTreeErr] = useState<string | null>(null);
  const [creatingTree, setCreatingTree] = useState(false);

  const { data: orgs } = useQuery<OrgWithStats[]>({
    queryKey: ["orgs"],
    queryFn: fetchOrgs,
  });

  const { data: projects } = useQuery<ProjectRow[]>({
    queryKey: ["projects"],
    queryFn: () => fetchProjects(),
  });

  const { data: tree } = useQuery<StrategyTree | null>({
    queryKey: ["strategy-tree", selectedProjectId],
    queryFn: () =>
      selectedProjectId ? fetchStrategyTree(selectedProjectId) : Promise.resolve(null),
    enabled: !!selectedProjectId,
  });

  const { data: nodeDetail } = useQuery({
    queryKey: ["strategy-node", selectedNodeId],
    queryFn: () =>
      selectedNodeId ? fetchStrategyNode(selectedNodeId) : Promise.resolve(null),
    enabled: !!selectedNodeId,
  });

  // Group projects by org
  const projectsByOrg = useMemo(() => {
    if (!projects || !orgs) return [];
    return orgs.map((org) => ({
      org,
      projects: projects.filter((p) => p.org_id === org.id),
    }));
  }, [projects, orgs]);

  const refreshTree = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["strategy-tree", selectedProjectId] });
    queryClient.invalidateQueries({ queryKey: ["strategy-node", selectedNodeId] });
  }, [queryClient, selectedProjectId, selectedNodeId]);

  const handleSelectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  const handleNavigateNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  const handleTitleChange = useCallback(
    async (nodeId: string, title: string) => {
      await apiFetch(`/strategy/node/${nodeId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      refreshTree();
    },
    [refreshTree],
  );

  const handleDescriptionChange = useCallback(
    async (nodeId: string, description: string) => {
      await apiFetch(`/strategy/node/${nodeId}`, {
        method: "PATCH",
        body: JSON.stringify({ description }),
      });
      refreshTree();
    },
    [refreshTree],
  );

  const handleCreateTree = useCallback(async () => {
    setCreateTreeErr(null);
    if (!selectedProjectId || !createTreeJson.trim()) {
      setCreateTreeErr("Pick a project and paste a tree JSON to begin.");
      return;
    }
    let treeData: object;
    try {
      const parsed = JSON.parse(createTreeJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setCreateTreeErr("Tree must be a JSON object at the top level.");
        return;
      }
      treeData = parsed as object;
    } catch (parseErr) {
      setCreateTreeErr(
        `Invalid JSON — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      );
      return;
    }
    const project = projects?.find((p) => p.id === selectedProjectId);
    if (!project) {
      setCreateTreeErr("Selected project no longer exists.");
      return;
    }
    setCreatingTree(true);
    try {
      await createTree({
        projectId: selectedProjectId,
        orgId: project.org_id,
        tree: treeData,
      });
      setShowCreateTree(false);
      setCreateTreeJson("");
      refreshTree();
    } catch (e) {
      setCreateTreeErr(
        e instanceof Error ? e.message : "Tree create failed — try again.",
      );
    } finally {
      setCreatingTree(false);
    }
  }, [selectedProjectId, createTreeJson, projects, refreshTree]);

  const handleFindNextActionable = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const node = await getNextActionable(selectedProjectId);
      if (node) {
        setSelectedNodeId(node.id);
      }
    } catch {
      // No actionable nodes
    }
  }, [selectedProjectId]);

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar */}
      <div className="flex-shrink-0 border-b border-slate-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            Strategy
          </h1>

          {/* Project selector grouped by org */}
          <select
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
            value={selectedProjectId ?? ""}
            onChange={(e) => {
              setSelectedProjectId(e.target.value || null);
              setSelectedNodeId(null);
            }}
          >
            <option value="">Select a project...</option>
            {projectsByOrg.map(({ org, projects: orgProjects }) =>
              orgProjects.length > 0 ? (
                <optgroup key={org.id} label={org.name}>
                  {orgProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ) : null,
            )}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <Link
            to="/strategy/graph"
            className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Graph view
          </Link>
          {selectedProjectId && (
            <>
              <button
                className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-300 hover:bg-slate-700 transition-colors"
                onClick={handleFindNextActionable}
              >
                Find Next Actionable
              </button>
              <button
                className="px-3 py-1.5 bg-blue-600 rounded-lg text-xs text-white hover:bg-blue-500 transition-colors"
                onClick={() => setShowCreateTree(!showCreateTree)}
              >
                Create Tree
              </button>
            </>
          )}
        </div>
      </div>

      {/* Overall progress */}
      {tree && (
        <div className="flex-shrink-0 border-b border-slate-800 px-6 py-2 flex items-center gap-4 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-300">
              {Math.round(tree.overallProgressPct)}% complete
            </span>
            <div className="w-32 h-1.5 bg-slate-700 rounded-full">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${Math.min(tree.overallProgressPct, 100)}%` }}
              />
            </div>
          </div>
          <span>
            {tree.completedLeaves}/{tree.totalLeaves} leaves done
          </span>
          <span>{tree.totalNodes} nodes total</span>
        </div>
      )}

      {/* Create tree modal */}
      {showCreateTree && (
        <div className="flex-shrink-0 border-b border-slate-800 px-6 py-4 bg-slate-800/50">
          <label className="text-xs text-slate-400 block mb-2">
            Paste tree JSON structure:
          </label>
          <textarea
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            rows={6}
            placeholder='{"type":"strategy","title":"My Strategy","children":[...]}'
            value={createTreeJson}
            onChange={(e) => setCreateTreeJson(e.target.value)}
          />
          {createTreeErr && (
            <div
              role="alert"
              className="mt-2 text-xs text-red-300 bg-red-950/40 border border-red-900 rounded p-2"
            >
              {createTreeErr}
            </div>
          )}
          <div className="flex gap-2 mt-2">
            <button
              className="px-3 py-1.5 bg-blue-600 rounded-lg text-xs text-white hover:bg-blue-500 disabled:opacity-50"
              onClick={handleCreateTree}
              disabled={creatingTree}
            >
              {creatingTree ? "Creating…" : "Create"}
            </button>
            <button
              className="px-3 py-1.5 bg-slate-700 rounded-lg text-xs text-slate-300"
              onClick={() => {
                setShowCreateTree(false);
                setCreateTreeErr(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Center: Tree view */}
        <div className="flex-1 overflow-auto p-4">
          {!selectedProjectId ? (
            <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
              Select a project to view its strategy tree.
            </div>
          ) : (
            <StrategyTreeView
              nodes={tree?.nodes ?? []}
              selectedNodeId={selectedNodeId}
              onSelectNode={handleSelectNode}
            />
          )}
        </div>

        {/* Right: Node detail panel */}
        {selectedNodeId && nodeDetail && (
          <aside className="w-96 flex-shrink-0 border-l border-slate-800 overflow-hidden">
            <StrategyNodeDetail
              node={nodeDetail.node}
              path={nodeDetail.path}
              children={nodeDetail.children}
              onNavigate={handleNavigateNode}
              onUpdate={refreshTree}
              onTitleChange={handleTitleChange}
              onDescriptionChange={handleDescriptionChange}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
