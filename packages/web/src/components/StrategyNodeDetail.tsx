import { useState, useCallback } from "react";
import type {
  StrategyNodeWithMetrics,
  StrategyNodeStatus,
  StrategyNodeType,
  NodeDependency,
  DependencyType,
} from "@nosleep/shared";
import {
  updateNodeStatus,
  setNodeProgress,
  createNode,
  addDependency,
  removeDependency,
  deleteNode,
} from "../lib/api";

interface StrategyNodeDetailProps {
  readonly node: StrategyNodeWithMetrics;
  readonly path: readonly { readonly id: string; readonly title: string }[];
  readonly children: readonly StrategyNodeWithMetrics[];
  readonly onNavigate: (nodeId: string) => void;
  readonly onUpdate: () => void;
  readonly onTitleChange: (nodeId: string, title: string) => void;
  readonly onDescriptionChange: (nodeId: string, description: string) => void;
}

const STATUS_OPTIONS: readonly StrategyNodeStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "skipped",
];

const STATUS_COLORS: Record<StrategyNodeStatus, string> = {
  pending: "text-slate-400",
  in_progress: "text-blue-400",
  completed: "text-green-400",
  blocked: "text-red-400",
  skipped: "text-slate-500",
};

const DEP_TYPE_COLORS: Record<DependencyType, string> = {
  FS: "bg-blue-500/20 text-blue-400",
  SS: "bg-amber-500/20 text-amber-400",
  FF: "bg-purple-500/20 text-purple-400",
  SF: "bg-red-500/20 text-red-400",
};

const CHILD_TYPES: readonly StrategyNodeType[] = ["goal", "task", "subtask"];

export function StrategyNodeDetail({
  node,
  path,
  children,
  onNavigate,
  onUpdate,
  onTitleChange,
  onDescriptionChange,
}: StrategyNodeDetailProps): React.ReactElement {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const [descDraft, setDescDraft] = useState(node.description);
  const [showAddChild, setShowAddChild] = useState(false);
  const [newChildType, setNewChildType] = useState<StrategyNodeType>("task");
  const [newChildTitle, setNewChildTitle] = useState("");
  const [showAddDep, setShowAddDep] = useState(false);
  const [newDepNodeId, setNewDepNodeId] = useState("");
  const [newDepType, setNewDepType] = useState<DependencyType>("FS");

  const handleStatusChange = useCallback(
    async (status: string) => {
      await updateNodeStatus(node.id, status);
      onUpdate();
    },
    [node.id, onUpdate],
  );

  const handleProgressChange = useCallback(
    async (pct: number) => {
      await setNodeProgress(node.id, pct);
      onUpdate();
    },
    [node.id, onUpdate],
  );

  const handleTitleSave = useCallback(() => {
    onTitleChange(node.id, titleDraft);
    setEditingTitle(false);
  }, [node.id, titleDraft, onTitleChange]);

  const handleDescSave = useCallback(() => {
    onDescriptionChange(node.id, descDraft);
    setEditingDesc(false);
  }, [node.id, descDraft, onDescriptionChange]);

  const handleAddChild = useCallback(async () => {
    if (!newChildTitle.trim()) return;
    await createNode({
      projectId: node.projectId,
      orgId: node.orgId,
      parentId: node.id,
      type: newChildType,
      title: newChildTitle.trim(),
    });
    setNewChildTitle("");
    setShowAddChild(false);
    onUpdate();
  }, [node, newChildType, newChildTitle, onUpdate]);

  const handleAddDep = useCallback(async () => {
    if (!newDepNodeId.trim()) return;
    await addDependency(node.id, { nodeId: newDepNodeId.trim(), type: newDepType });
    setNewDepNodeId("");
    setShowAddDep(false);
    onUpdate();
  }, [node.id, newDepNodeId, newDepType, onUpdate]);

  const handleRemoveDep = useCallback(
    async (targetId: string) => {
      await removeDependency(node.id, targetId);
      onUpdate();
    },
    [node.id, onUpdate],
  );

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete "${node.title}" and all its children?`)) return;
    await deleteNode(node.id);
    onUpdate();
  }, [node.id, node.title, onUpdate]);

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Breadcrumb path */}
      <div className="flex items-center gap-1 px-4 py-3 border-b border-slate-800 text-xs text-slate-500 flex-wrap">
        {path.map((crumb, idx) => (
          <span key={crumb.id} className="flex items-center gap-1">
            {idx > 0 && <span className="text-slate-600">&gt;</span>}
            <button
              className={`hover:text-slate-300 transition-colors ${
                crumb.id === node.id ? "text-slate-300 font-medium" : ""
              }`}
              onClick={() => onNavigate(crumb.id)}
            >
              {crumb.title}
            </button>
          </span>
        ))}
      </div>

      <div className="p-4 space-y-5 flex-1 overflow-auto">
        {/* Title */}
        <div>
          {editingTitle ? (
            <div className="flex gap-2">
              <input
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white text-lg font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleTitleSave();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                autoFocus
              />
              <button
                className="px-2 py-1 bg-blue-600 rounded text-xs text-white"
                onClick={handleTitleSave}
              >
                Save
              </button>
            </div>
          ) : (
            <h2
              className="text-lg font-semibold text-white cursor-pointer hover:text-blue-400 transition-colors"
              onClick={() => {
                setTitleDraft(node.title);
                setEditingTitle(true);
              }}
            >
              {node.title}
            </h2>
          )}
        </div>

        {/* Description */}
        <div>
          <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
            Description
          </label>
          {editingDesc ? (
            <div className="mt-1 flex flex-col gap-2">
              <textarea
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                rows={3}
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  className="px-2 py-1 bg-blue-600 rounded text-xs text-white"
                  onClick={handleDescSave}
                >
                  Save
                </button>
                <button
                  className="px-2 py-1 bg-slate-700 rounded text-xs text-slate-300"
                  onClick={() => setEditingDesc(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p
              className="mt-1 text-sm text-slate-400 cursor-pointer hover:text-slate-300 transition-colors min-h-[1.5rem]"
              onClick={() => {
                setDescDraft(node.description);
                setEditingDesc(true);
              }}
            >
              {node.description || "Click to add description..."}
            </p>
          )}
        </div>

        {/* Status selector */}
        <div>
          <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
            Status
          </label>
          <select
            className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
            value={node.status}
            onChange={(e) => handleStatusChange(e.target.value)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
          <span className={`text-xs mt-1 ${STATUS_COLORS[node.status]}`}>
            {node.status.replace("_", " ")}
          </span>
        </div>

        {/* Progress slider */}
        <div>
          <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
            Progress ({Math.round(node.computedProgressPct)}%)
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={node.progressPct}
            onChange={(e) => handleProgressChange(Number(e.target.value))}
            className="mt-1 w-full accent-blue-500"
          />
        </div>

        {/* Dependencies */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
              Dependencies ({node.dependencies.length})
            </label>
            <button
              className="text-xs text-blue-400 hover:text-blue-300"
              onClick={() => setShowAddDep(!showAddDep)}
            >
              + Add
            </button>
          </div>
          {showAddDep && (
            <div className="mt-2 flex gap-2">
              <input
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Node ID"
                value={newDepNodeId}
                onChange={(e) => setNewDepNodeId(e.target.value)}
              />
              <select
                className="bg-slate-800 border border-slate-700 rounded px-1 py-1 text-xs text-slate-300"
                value={newDepType}
                onChange={(e) => setNewDepType(e.target.value as DependencyType)}
              >
                <option value="FS">FS</option>
                <option value="SS">SS</option>
                <option value="FF">FF</option>
                <option value="SF">SF</option>
              </select>
              <button
                className="px-2 py-1 bg-blue-600 rounded text-xs text-white"
                onClick={handleAddDep}
              >
                Add
              </button>
            </div>
          )}
          <div className="mt-2 space-y-1">
            {node.dependencies.map((dep: NodeDependency) => (
              <div
                key={dep.nodeId}
                className="flex items-center gap-2 text-xs"
              >
                <span
                  className={`px-1.5 py-0.5 rounded font-semibold ${DEP_TYPE_COLORS[dep.type]}`}
                >
                  {dep.type}
                </span>
                <span className="text-slate-400 truncate">{dep.nodeId}</span>
                <button
                  className="text-red-400 hover:text-red-300 ml-auto"
                  onClick={() => handleRemoveDep(dep.nodeId)}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Assigned session */}
        {node.assignedSessionId && (
          <div>
            <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
              Assigned Session
            </label>
            <p className="mt-1 text-sm text-indigo-400">
              {node.assignedSessionId}
            </p>
          </div>
        )}

        {/* Children list */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
              Children ({children.length})
            </label>
            <button
              className="text-xs text-blue-400 hover:text-blue-300"
              onClick={() => setShowAddChild(!showAddChild)}
            >
              + Add Child
            </button>
          </div>
          {showAddChild && (
            <div className="mt-2 flex gap-2">
              <select
                className="bg-slate-800 border border-slate-700 rounded px-1 py-1 text-xs text-slate-300"
                value={newChildType}
                onChange={(e) => setNewChildType(e.target.value as StrategyNodeType)}
              >
                {CHILD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Title"
                value={newChildTitle}
                onChange={(e) => setNewChildTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddChild();
                }}
              />
              <button
                className="px-2 py-1 bg-blue-600 rounded text-xs text-white"
                onClick={handleAddChild}
              >
                Add
              </button>
            </div>
          )}
          <div className="mt-2 space-y-1">
            {children.map((child) => (
              <button
                key={child.id}
                className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-slate-800/50 transition-colors"
                onClick={() => onNavigate(child.id)}
              >
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    child.status === "completed"
                      ? "bg-green-500"
                      : child.status === "in_progress"
                        ? "bg-blue-500"
                        : child.status === "blocked"
                          ? "bg-red-500"
                          : "bg-slate-500"
                  }`}
                />
                <span className="text-sm text-slate-300 truncate">
                  {child.title}
                </span>
                <span className="text-[10px] text-slate-500 ml-auto">
                  {Math.round(child.computedProgressPct)}%
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Delete button */}
        <div className="pt-4 border-t border-slate-800">
          <button
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
            onClick={handleDelete}
          >
            Delete this node
          </button>
        </div>
      </div>
    </div>
  );
}
