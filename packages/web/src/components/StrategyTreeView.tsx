import { useState, useCallback, useMemo } from "react";
import type { StrategyNodeWithMetrics, StrategyNodeStatus, StrategyNodeType, NodeDependency } from "@nosleep/shared";

interface StrategyTreeViewProps {
  readonly nodes: readonly StrategyNodeWithMetrics[];
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
}

const STATUS_STYLES: Record<StrategyNodeStatus, string> = {
  pending: "bg-slate-500",
  in_progress: "bg-blue-500 animate-pulse",
  completed: "bg-green-500",
  blocked: "bg-red-500",
  skipped: "bg-slate-500",
};

const TYPE_BADGE_STYLES: Record<StrategyNodeType, string> = {
  strategy: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  goal: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  task: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  subtask: "bg-slate-500/20 text-slate-400 border-slate-500/30",
};

function buildChildMap(
  nodes: readonly StrategyNodeWithMetrics[],
): Map<string | null, StrategyNodeWithMetrics[]> {
  const map = new Map<string | null, StrategyNodeWithMetrics[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const existing = map.get(key);
    if (existing) {
      existing.push(node);
    } else {
      map.set(key, [node]);
    }
  }
  // Sort children by sortOrder
  for (const children of map.values()) {
    children.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return map;
}

function findRoots(nodes: readonly StrategyNodeWithMetrics[]): StrategyNodeWithMetrics[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  return nodes
    .filter((n) => n.parentId === null || !nodeIds.has(n.parentId))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function NodeRow({
  node,
  childMap,
  nodeMap,
  collapsed,
  selectedId,
  onToggle,
  onSelect,
}: {
  readonly node: StrategyNodeWithMetrics;
  readonly childMap: Map<string | null, StrategyNodeWithMetrics[]>;
  readonly nodeMap: Map<string, StrategyNodeWithMetrics>;
  readonly collapsed: Set<string>;
  readonly selectedId: string | null;
  readonly onToggle: (id: string) => void;
  readonly onSelect: (id: string) => void;
}): React.ReactElement {
  const children = childMap.get(node.id) ?? [];
  const hasChildren = children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const isSelected = selectedId === node.id;
  const isSkipped = node.status === "skipped";

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-1.5 px-2 rounded-lg cursor-pointer transition-colors group ${
          isSelected
            ? "bg-slate-700 ring-1 ring-blue-500/50"
            : "hover:bg-slate-800/50"
        }`}
        style={{ paddingLeft: `${node.depth * 24 + 8}px` }}
        onClick={() => onSelect(node.id)}
      >
        {/* Expand/Collapse toggle */}
        <button
          className={`w-4 h-4 flex items-center justify-center text-slate-500 text-xs flex-shrink-0 ${
            hasChildren ? "hover:text-white" : "invisible"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
        >
          {hasChildren ? (isCollapsed ? "\u25B6" : "\u25BC") : ""}
        </button>

        {/* Status dot */}
        <span
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_STYLES[node.status]}`}
        />

        {/* Type badge */}
        <span
          className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${TYPE_BADGE_STYLES[node.type]}`}
        >
          {node.type}
        </span>

        {/* Title */}
        <span
          className={`text-sm font-medium truncate ${
            isSkipped
              ? "text-slate-500 line-through"
              : "text-slate-200"
          }`}
        >
          {node.title}
        </span>

        {/* Progress bar */}
        <div className="w-20 h-1.5 bg-slate-700 rounded-full flex-shrink-0 ml-auto">
          <div
            className={`h-full rounded-full transition-all ${
              node.computedProgressPct >= 100
                ? "bg-green-500"
                : node.computedProgressPct > 0
                  ? "bg-blue-500"
                  : "bg-slate-600"
            }`}
            style={{ width: `${Math.min(node.computedProgressPct, 100)}%` }}
          />
        </div>

        {/* Metrics on parent nodes */}
        {hasChildren && (
          <span className="text-[10px] text-slate-500 flex-shrink-0 whitespace-nowrap">
            {node.completedLeaves}/{node.totalLeaves} done, d{node.maxDepthBelow}
          </span>
        )}

        {/* Dependencies — guard against legacy/malformed rows where the
            dep was stored as a bare string id instead of {nodeId,type}.
            Render those as {nodeId: dep, type: "FS"} so the page still
            mounts; a migration cleans the rows up separately. */}
        {node.dependencies.length > 0 && (
          <div className="flex gap-1 flex-shrink-0">
            {node.dependencies.map((raw, idx) => {
              const dep: NodeDependency =
                typeof raw === "string"
                  ? { nodeId: raw, type: "FS" }
                  : (raw as NodeDependency);
              const nodeId = dep?.nodeId;
              if (!nodeId || typeof nodeId !== "string") return null;
              const depNode = nodeMap.get(nodeId);
              const label = depNode
                ? depNode.title.slice(0, 12)
                : nodeId.slice(0, 6);
              const depType = dep.type ?? "FS";
              return (
                <span
                  key={`${nodeId}-${idx}`}
                  className="text-[9px] bg-slate-700 text-slate-400 px-1 py-0.5 rounded"
                  title={`${depType}: ${depNode?.title ?? nodeId}`}
                >
                  {depType}&rarr;{label}
                </span>
              );
            })}
          </div>
        )}

        {/* Assigned session badge */}
        {node.assignedSessionId && (
          <span className="text-[9px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded flex-shrink-0">
            {node.assignedSessionId.slice(0, 8)}
          </span>
        )}
      </div>

      {/* Children */}
      {hasChildren && !isCollapsed && (
        <div>
          {children.map((child) => (
            <NodeRow
              key={child.id}
              node={child}
              childMap={childMap}
              nodeMap={nodeMap}
              collapsed={collapsed}
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

export function StrategyTreeView({
  nodes,
  selectedNodeId,
  onSelectNode,
}: StrategyTreeViewProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const childMap = useMemo(() => buildChildMap(nodes), [nodes]);
  const nodeMap = useMemo(() => {
    const map = new Map<string, StrategyNodeWithMetrics>();
    for (const node of nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [nodes]);
  const roots = useMemo(() => findRoots(nodes), [nodes]);

  const handleToggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
        No strategy tree found. Create one to get started.
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {roots.map((root) => (
        <NodeRow
          key={root.id}
          node={root}
          childMap={childMap}
          nodeMap={nodeMap}
          collapsed={collapsed}
          selectedId={selectedNodeId}
          onToggle={handleToggle}
          onSelect={onSelectNode}
        />
      ))}
    </div>
  );
}
