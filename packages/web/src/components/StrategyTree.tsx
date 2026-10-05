import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchStrategyTree, updateNodeStatus, setNodeProgress } from "../lib/api";
import type { StrategyNodeWithMetrics, StrategyNodeStatus, StrategyNodeType } from "@nosleep/shared";

// ── Constants ────────────────────────────────────────────

const STATUS_CONFIG: Record<StrategyNodeStatus, { icon: string; color: string; bg: string; border: string }> = {
  pending:     { icon: "\u25CB", color: "text-slate-400",  bg: "bg-slate-500/10",  border: "border-slate-500/30" },
  in_progress: { icon: "\u25C9", color: "text-blue-400",   bg: "bg-blue-500/10",   border: "border-blue-500/30" },
  completed:   { icon: "\u25CF", color: "text-green-400",  bg: "bg-green-500/10",  border: "border-green-500/30" },
  blocked:     { icon: "\u2715", color: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/30" },
  skipped:     { icon: "\u2298", color: "text-gray-500",   bg: "bg-gray-500/10",   border: "border-gray-500/30" },
};

const TYPE_CONFIG: Record<StrategyNodeType, { label: string; classes: string }> = {
  strategy: { label: "STR", classes: "bg-purple-500/20 text-purple-300 border-purple-500/30" },
  goal:     { label: "GOL", classes: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  task:     { label: "TSK", classes: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" },
  subtask:  { label: "SUB", classes: "bg-slate-500/20 text-slate-300 border-slate-500/30" },
};

const STATUS_OPTIONS: StrategyNodeStatus[] = ["pending", "in_progress", "completed", "blocked", "skipped"];

// ── Tree Node Type ───────────────────────────────────────

interface TreeNode {
  readonly node: StrategyNodeWithMetrics;
  readonly children: TreeNode[];
}

// ── Helper: Build nested tree from flat array ────────────

function buildTree(nodes: readonly StrategyNodeWithMetrics[]): TreeNode[] {
  const childrenMap = new Map<string | null, StrategyNodeWithMetrics[]>();

  for (const node of nodes) {
    const siblings = childrenMap.get(node.parentId) ?? [];
    childrenMap.set(node.parentId, [...siblings, node]);
  }

  // Sort siblings by sortOrder
  for (const [key, siblings] of childrenMap.entries()) {
    childrenMap.set(key, siblings.sort((a, b) => a.sortOrder - b.sortOrder));
  }

  function buildSubtree(parentId: string | null): TreeNode[] {
    const children = childrenMap.get(parentId) ?? [];
    return children.map((node) => ({
      node,
      children: buildSubtree(node.id),
    }));
  }

  return buildSubtree(null);
}

// ── Progress Bar ─────────────────────────────────────────

function ProgressBar({
  pct,
  size = "sm",
}: {
  readonly pct: number;
  readonly size?: "sm" | "md";
}): React.ReactElement {
  const height = size === "sm" ? "h-1.5" : "h-2";
  const clampedPct = Math.max(0, Math.min(100, pct));

  let barColor = "bg-slate-500";
  if (clampedPct >= 100) barColor = "bg-green-500";
  else if (clampedPct > 0) barColor = "bg-blue-500";

  return (
    <div className={`w-full ${height} bg-slate-700 rounded-full overflow-hidden`}>
      <div
        className={`${height} ${barColor} rounded-full transition-all duration-300`}
        style={{ width: `${clampedPct}%` }}
      />
    </div>
  );
}

// ── Metrics Summary ──────────────────────────────────────

function MetricsSummary({
  totalNodes,
  totalLeaves,
  completedLeaves,
  overallProgressPct,
}: {
  readonly totalNodes: number;
  readonly totalLeaves: number;
  readonly completedLeaves: number;
  readonly overallProgressPct: number;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-4 mb-4 p-3 bg-slate-800 rounded-xl border border-slate-700/50">
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-slate-400">Overall Progress</span>
          <span className="text-xs font-mono text-slate-300">{Math.round(overallProgressPct)}%</span>
        </div>
        <ProgressBar pct={overallProgressPct} size="md" />
      </div>
      <div className="flex gap-3 pl-3 border-l border-slate-700/50">
        <MetricPill label="Nodes" value={totalNodes} />
        <MetricPill label="Leaves" value={totalLeaves} />
        <MetricPill label="Done" value={completedLeaves} accent="green" />
      </div>
    </div>
  );
}

function MetricPill({
  label,
  value,
  accent,
}: {
  readonly label: string;
  readonly value: number;
  readonly accent?: "green";
}): React.ReactElement {
  const valueColor = accent === "green" ? "text-green-400" : "text-white";
  return (
    <div className="text-center">
      <div className={`text-sm font-semibold ${valueColor}`}>{value}</div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</div>
    </div>
  );
}

// ── Detail Panel ─────────────────────────────────────────

function DetailPanel({
  node,
  onClose,
  onStatusChange,
  onProgressChange,
}: {
  readonly node: StrategyNodeWithMetrics;
  readonly onClose: () => void;
  readonly onStatusChange: (nodeId: string, status: StrategyNodeStatus) => void;
  readonly onProgressChange: (nodeId: string, pct: number) => void;
}): React.ReactElement {
  const statusCfg = STATUS_CONFIG[node.status];
  const typeCfg = TYPE_CONFIG[node.type];

  return (
    <div className="mt-3 p-4 bg-slate-800 rounded-xl border border-slate-700/50">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${typeCfg.classes}`}>
            {typeCfg.label}
          </span>
          <h3 className="text-sm font-semibold text-white">{node.title}</h3>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white transition-colors text-sm leading-none"
        >
          &times;
        </button>
      </div>

      {node.description && (
        <p className="text-xs text-slate-400 mb-3 leading-relaxed">{node.description}</p>
      )}

      {/* Status selector */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-slate-500">Status:</span>
        <div className="flex gap-1">
          {STATUS_OPTIONS.map((s) => {
            const cfg = STATUS_CONFIG[s];
            const isActive = node.status === s;
            return (
              <button
                key={s}
                onClick={() => onStatusChange(node.id, s)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                  isActive
                    ? `${cfg.bg} ${cfg.color} ${cfg.border}`
                    : "border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600"
                }`}
              >
                {cfg.icon} {s.replace("_", " ")}
              </button>
            );
          })}
        </div>
      </div>

      {/* Progress slider (only for leaf nodes) */}
      {node.totalLeaves <= 1 && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-slate-500">Progress:</span>
            <span className="text-xs font-mono text-slate-300">{Math.round(node.computedProgressPct)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={node.computedProgressPct}
            onChange={(e) => onProgressChange(node.id, parseInt(e.target.value, 10))}
            className="w-full h-1.5 bg-slate-700 rounded-full appearance-none cursor-pointer accent-blue-500"
          />
        </div>
      )}

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        <div className="text-center p-2 bg-slate-900/50 rounded-lg">
          <div className="text-xs font-semibold text-white">{node.totalLeaves}</div>
          <div className="text-[9px] text-slate-500">Leaves</div>
        </div>
        <div className="text-center p-2 bg-slate-900/50 rounded-lg">
          <div className="text-xs font-semibold text-green-400">{node.completedLeaves}</div>
          <div className="text-[9px] text-slate-500">Done</div>
        </div>
        <div className="text-center p-2 bg-slate-900/50 rounded-lg">
          <div className="text-xs font-semibold text-blue-400">{node.activeLeaves}</div>
          <div className="text-[9px] text-slate-500">Active</div>
        </div>
        <div className="text-center p-2 bg-slate-900/50 rounded-lg">
          <div className="text-xs font-semibold text-red-400">{node.blockedLeaves}</div>
          <div className="text-[9px] text-slate-500">Blocked</div>
        </div>
      </div>

      {/* Acceptance criteria */}
      {node.acceptanceCriteria.length > 0 && (
        <div>
          <span className="text-xs text-slate-500 mb-1 block">Acceptance Criteria ({node.acceptanceCriteria.length}):</span>
          <ul className="space-y-0.5">
            {node.acceptanceCriteria.map((criterion, i) => (
              <li key={i} className="text-xs text-slate-300 flex gap-1.5">
                <span className="text-slate-600 select-none">--</span>
                {criterion}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Metadata row */}
      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-slate-700/30">
        {node.weight > 1 && (
          <span className="text-[10px] text-slate-500">Weight: {node.weight}</span>
        )}
        {node.estimatedTokens > 0 && (
          <span className="text-[10px] text-slate-500">Est. tokens: {node.estimatedTokens.toLocaleString()}</span>
        )}
        {node.assignedSessionId && (
          <span className="text-[10px] text-blue-400">Session: {node.assignedSessionId.slice(0, 8)}...</span>
        )}
        {node.priority && (
          <span className="text-[10px] text-amber-400 font-semibold">PRIORITY</span>
        )}
        {node.dependencies.length > 0 && (
          <span className="text-[10px] text-slate-500">Deps: {node.dependencies.length}</span>
        )}
      </div>
    </div>
  );
}

// ── Tree Node Row ────────────────────────────────────────

function TreeNodeRow({
  treeNode,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
}: {
  readonly treeNode: TreeNode;
  readonly expandedIds: Set<string>;
  readonly selectedId: string | null;
  readonly onToggle: (id: string) => void;
  readonly onSelect: (id: string) => void;
}): React.ReactElement {
  const { node, children } = treeNode;
  const hasChildren = children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;
  const statusCfg = STATUS_CONFIG[node.status];
  const typeCfg = TYPE_CONFIG[node.type];

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-1.5 px-2 rounded-lg cursor-pointer transition-colors group ${
          isSelected
            ? "bg-slate-700/50 border border-slate-600/50"
            : "hover:bg-slate-800/70 border border-transparent"
        }`}
        style={{ paddingLeft: `${node.depth * 20 + 8}px` }}
      >
        {/* Expand/collapse toggle */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
          className={`w-4 h-4 flex items-center justify-center text-[10px] transition-transform ${
            hasChildren ? "text-slate-400 hover:text-white" : "text-transparent"
          } ${isExpanded ? "rotate-90" : ""}`}
        >
          {hasChildren ? "\u25B6" : "\u00B7"}
        </button>

        {/* Clickable row content */}
        <div
          className="flex items-center gap-2 flex-1 min-w-0"
          onClick={() => onSelect(node.id)}
        >
          {/* Type badge */}
          <span className={`text-[9px] font-semibold px-1 py-px rounded border shrink-0 ${typeCfg.classes}`}>
            {typeCfg.label}
          </span>

          {/* Status icon */}
          <span className={`text-sm leading-none shrink-0 ${statusCfg.color}`}>
            {statusCfg.icon}
          </span>

          {/* Title */}
          <span className={`text-xs truncate ${
            node.status === "completed" ? "text-slate-500 line-through" :
            node.status === "skipped" ? "text-slate-600" :
            "text-slate-200"
          }`}>
            {node.title}
          </span>

          {/* Weight badge */}
          {node.weight > 1 && (
            <span className="text-[9px] text-slate-600 font-mono shrink-0">x{node.weight}</span>
          )}

          {/* Acceptance criteria count */}
          {node.acceptanceCriteria.length > 0 && (
            <span className="text-[9px] text-slate-600 shrink-0">
              [{node.acceptanceCriteria.length} AC]
            </span>
          )}

          {/* Priority flag */}
          {node.priority && (
            <span className="text-[9px] text-amber-500 font-semibold shrink-0">PRI</span>
          )}
        </div>

        {/* Progress bar (inline, right side) */}
        <div className="w-16 shrink-0">
          <ProgressBar pct={node.computedProgressPct} />
        </div>
        <span className="text-[10px] font-mono text-slate-500 w-8 text-right shrink-0">
          {Math.round(node.computedProgressPct)}%
        </span>
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div>
          {children.map((child) => (
            <TreeNodeRow
              key={child.node.id}
              treeNode={child}
              expandedIds={expandedIds}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────

export function StrategyTree({
  projectId,
}: {
  readonly projectId: string;
}): React.ReactElement {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [initialExpanded, setInitialExpanded] = useState(false);

  const { data: tree, isLoading, error, refetch } = useQuery({
    queryKey: ["strategy-tree", projectId],
    queryFn: () => fetchStrategyTree(projectId),
    refetchInterval: 15_000,
  });

  // Build nested structure from flat nodes
  const treeNodes = useMemo(() => {
    if (!tree) return [];
    return buildTree(tree.nodes);
  }, [tree]);

  // Auto-expand first two levels on initial load
  useMemo(() => {
    if (tree && !initialExpanded) {
      const idsToExpand = new Set<string>();
      for (const node of tree.nodes) {
        if (node.depth < 2) {
          idsToExpand.add(node.id);
        }
      }
      setExpandedIds(idsToExpand);
      setInitialExpanded(true);
    }
  }, [tree, initialExpanded]);

  const selectedNode = useMemo(() => {
    if (!selectedId || !tree) return null;
    return tree.nodes.find((n) => n.id === selectedId) ?? null;
  }, [selectedId, tree]);

  const handleToggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelect = useCallback((id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const handleExpandAll = useCallback(() => {
    if (!tree) return;
    setExpandedIds(new Set(tree.nodes.map((n) => n.id)));
  }, [tree]);

  const handleCollapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  const handleStatusChange = useCallback(async (nodeId: string, status: StrategyNodeStatus) => {
    try {
      await updateNodeStatus(nodeId, status);
      refetch();
    } catch {
      // Silently fail — tree will refresh on next interval
    }
  }, [refetch]);

  const handleProgressChange = useCallback(async (nodeId: string, pct: number) => {
    try {
      await setNodeProgress(nodeId, pct);
      refetch();
    } catch {
      // Silently fail
    }
  }, [refetch]);

  // Loading state
  if (isLoading) {
    return (
      <div className="p-4 bg-slate-900 rounded-xl border border-slate-700/50">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="animate-pulse">Loading strategy tree...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-4 bg-slate-900 rounded-xl border border-red-500/30">
        <div className="text-sm text-red-400">
          Failed to load strategy tree: {error instanceof Error ? error.message : "Unknown error"}
        </div>
      </div>
    );
  }

  // Empty state
  if (!tree || tree.totalNodes === 0) {
    return (
      <div className="p-4 bg-slate-900 rounded-xl border border-slate-700/50">
        <div className="text-sm text-slate-500 text-center py-4">
          No strategy tree defined for this project.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-700/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/30">
        <h3 className="text-sm font-semibold text-white">Strategy Tree</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExpandAll}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            Expand all
          </button>
          <span className="text-slate-700">|</span>
          <button
            onClick={handleCollapseAll}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            Collapse all
          </button>
        </div>
      </div>

      {/* Metrics */}
      <div className="px-4 pt-3">
        <MetricsSummary
          totalNodes={tree.totalNodes}
          totalLeaves={tree.totalLeaves}
          completedLeaves={tree.completedLeaves}
          overallProgressPct={tree.overallProgressPct}
        />
      </div>

      {/* Tree */}
      <div className="px-2 pb-3 max-h-[600px] overflow-y-auto">
        {treeNodes.map((treeNode) => (
          <TreeNodeRow
            key={treeNode.node.id}
            treeNode={treeNode}
            expandedIds={expandedIds}
            selectedId={selectedId}
            onToggle={handleToggle}
            onSelect={handleSelect}
          />
        ))}
      </div>

      {/* Detail panel */}
      {selectedNode && (
        <div className="px-4 pb-4">
          <DetailPanel
            node={selectedNode}
            onClose={() => setSelectedId(null)}
            onStatusChange={handleStatusChange}
            onProgressChange={handleProgressChange}
          />
        </div>
      )}
    </div>
  );
}
