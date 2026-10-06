import React, { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  apiFetch,
  fetchOrgs,
  fetchProjects,
  createProject,
  fetchIterationSteps,
  updateIterationSteps,
  resetIterationSteps,
  type OrgWithStats,
  type ProjectRow,
  type IterationStep,
} from "../lib/api";
import { OrgBadge } from "../components/OrgBadge";
import { StatusDot } from "../components/StatusDot";
import { LaunchModal } from "../components/LaunchModal";
import { StrategyTree } from "../components/StrategyTree";
import {
  HookGlobalActions,
  HookOrgAction,
  HookBadge,
  useHookManagement,
} from "../components/HookActions";

export function Projects(): React.ReactElement {
  const queryClient = useQueryClient();
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());
  const [showNewForm, setShowNewForm] = useState(false);
  const [launchProject, setLaunchProject] = useState<{ id: string; name: string } | null>(null);
  const [workflowProject, setWorkflowProject] = useState<{ id: string; name: string } | null>(null);
  const [strategyProjectId, setStrategyProjectId] = useState<string | null>(null);

  const {
    hookStatuses,
    isLoading: hooksLoading,
    installAll,
    uninstallAll,
    installOrg,
    installProject,
    uninstallProject,
    toasts,
    ToastContainer,
  } = useHookManagement();

  // Fetch accounts for auto-mapping org → account
  const { data: accounts } = useQuery<{ id: string; org_id: string; name: string }[]>({
    queryKey: ["accounts"],
    queryFn: () => apiFetch("/accounts"),
  });

  // New project form state
  const [newProject, setNewProject] = useState({
    orgId: "",
    name: "",
    path: "",
    tokenBudget: 500000,
    autonomyLevel: "supervised",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const { data: orgs } = useQuery<OrgWithStats[]>({
    queryKey: ["orgs"],
    queryFn: fetchOrgs,
  });

  const { data: projects } = useQuery<ProjectRow[]>({
    queryKey: ["projects"],
    queryFn: () => fetchProjects(),
  });

  // Group projects by org
  const groupedProjects = useMemo(() => {
    const groups = new Map<string, ProjectRow[]>();
    for (const project of projects ?? []) {
      const orgProjects = groups.get(project.org_id) ?? [];
      groups.set(project.org_id, [...orgProjects, project]);
    }
    return groups;
  }, [projects]);

  const toggleOrg = (orgId: string) => {
    setExpandedOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(orgId)) next.delete(orgId);
      else next.add(orgId);
      return next;
    });
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!newProject.orgId || !newProject.name || !newProject.path) {
      setFormError("Organization, name, and path are required.");
      return;
    }

    const accountId = accounts?.find((a) => a.org_id === newProject.orgId)?.id;
    if (!accountId) {
      setFormError("No account found for this organization.");
      return;
    }

    try {
      await createProject({
        orgId: newProject.orgId,
        name: newProject.name,
        path: newProject.path,
        accountId,
        tokenBudget: newProject.tokenBudget,
        autonomyLevel: newProject.autonomyLevel,
      });
      setNewProject({ orgId: "", name: "", path: "", tokenBudget: 500000, autonomyLevel: "supervised" });
      setShowNewForm(false);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create project");
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Projects</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {projects?.length ?? 0} projects across {orgs?.length ?? 0} organizations
          </p>
        </div>
        <div className="flex items-center gap-3">
          <HookGlobalActions
            onInstallAll={installAll}
            onUninstallAll={uninstallAll}
            isLoading={hooksLoading}
          />
          <button
            onClick={() => setShowNewForm((v) => !v)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {showNewForm ? "Cancel" : "+ New Project"}
          </button>
        </div>
      </div>

      {/* New Project Form */}
      {showNewForm && (
        <div className="mb-6 bg-slate-800 rounded-xl border border-slate-700/50 p-5">
          <h3 className="text-sm font-semibold text-white mb-4">New Project</h3>
          {formError && (
            <div className="mb-3 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-400">
              {formError}
            </div>
          )}
          <form onSubmit={handleCreateProject} className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Organization</label>
              <select
                value={newProject.orgId}
                onChange={(e) => setNewProject({ ...newProject, orgId: e.target.value })}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                <option value="">Select org...</option>
                {orgs?.map((org) => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Name</label>
              <input
                value={newProject.name}
                onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                placeholder="my-project"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-400 mb-1">Path</label>
              <input
                value={newProject.path}
                onChange={(e) => setNewProject({ ...newProject, path: e.target.value })}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                placeholder="/path/to/my-project"
              />
              <p className="text-xs text-slate-500 mt-1">Folder will be created and git-initialized if it doesn't exist</p>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Token Budget</label>
              <input
                type="number"
                value={newProject.tokenBudget}
                onChange={(e) => setNewProject({ ...newProject, tokenBudget: parseInt(e.target.value) || 0 })}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Autonomy Level</label>
              <select
                value={newProject.autonomyLevel}
                onChange={(e) => setNewProject({ ...newProject, autonomyLevel: e.target.value })}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                <option value="full">Full</option>
                <option value="supervised">Supervised</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div className="col-span-2 flex justify-end">
              <button
                type="submit"
                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Create Project
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Grouped project list */}
      <div className="space-y-4">
        {orgs?.map((org) => {
          const orgProjects = groupedProjects.get(org.id) ?? [];
          const isExpanded = expandedOrgs.has(org.id) || expandedOrgs.size === 0;

          return (
            <div key={org.id} className="bg-slate-800/50 rounded-xl border border-slate-700/30 overflow-hidden">
              {/* Header row: the expand toggle and the org-level "Install
                  Hooks" action are SIBLING buttons — a <button> inside a
                  <button> is invalid HTML (React console error) and makes
                  the inner action unreachable to keyboard/AT users. */}
              <div className="flex items-center gap-3 hover:bg-slate-800/80 transition-colors">
                <button
                  type="button"
                  onClick={() => toggleOrg(org.id)}
                  aria-expanded={isExpanded}
                  aria-controls={`org-projects-${org.id}`}
                  className="flex-1 min-w-0 pl-5 py-3 flex items-center gap-3 text-left"
                >
                  <OrgBadge slug={org.slug} name={org.name} color={org.color} size="md" />
                  <span className="text-sm text-slate-500">{orgProjects.length} {orgProjects.length === 1 ? "project" : "projects"}</span>
                </button>
                <HookOrgAction
                  orgId={org.id}
                  onInstall={installOrg}
                  isLoading={hooksLoading}
                />
                <button
                  type="button"
                  onClick={() => toggleOrg(org.id)}
                  aria-expanded={isExpanded}
                  aria-controls={`org-projects-${org.id}`}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${org.name}`}
                  className="pl-3 pr-5 py-3"
                >
                  <svg
                    className={`w-4 h-4 text-slate-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>

              {isExpanded && orgProjects.length > 0 && (
                <div id={`org-projects-${org.id}`} className="border-t border-slate-700/30">
                  <table className="w-full">
                    <thead>
                      <tr className="text-xs text-slate-500 uppercase tracking-wider">
                        <th className="text-left px-5 py-2 font-medium">Name</th>
                        <th className="text-left px-5 py-2 font-medium">Path</th>
                        <th className="text-left px-5 py-2 font-medium">Account</th>
                        <th className="text-left px-5 py-2 font-medium">Autonomy</th>
                        <th className="text-left px-5 py-2 font-medium">Status</th>
                        <th className="text-left px-5 py-2 font-medium">Hooks</th>
                        <th className="text-right px-5 py-2 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orgProjects.map((project) => (
                        <React.Fragment key={project.id}>
                        <tr
                          className="border-t border-slate-700/20 hover:bg-slate-800/50 transition-colors"
                        >
                          <td className="px-5 py-3 text-sm text-white font-medium">{project.name}</td>
                          <td className="px-5 py-3 text-xs text-slate-500 font-mono truncate max-w-[200px]">
                            {project.path}
                          </td>
                          <td className="px-5 py-3 text-xs text-slate-400">
                            {project.account_name}
                            <span className="ml-1 text-slate-600">({project.account_type})</span>
                          </td>
                          <td className="px-5 py-3 text-xs text-slate-400 capitalize">{project.autonomy_level}</td>
                          <td className="px-5 py-3"><StatusDot status={project.status} /></td>
                          <td className="px-5 py-3">
                            <HookBadge
                              projectId={project.id}
                              hookStatuses={hookStatuses}
                              onInstall={installProject}
                              onUninstall={uninstallProject}
                              isLoading={hooksLoading}
                            />
                          </td>
                          <td className="px-5 py-3 text-right space-x-2">
                            <button
                              onClick={() => setStrategyProjectId((prev) => prev === project.id ? null : project.id)}
                              className={`text-xs px-3 py-1 rounded-lg transition-colors ${
                                strategyProjectId === project.id
                                  ? "text-purple-300 bg-purple-500/20 hover:bg-purple-500/30"
                                  : "text-purple-400 hover:text-purple-300 bg-purple-500/10 hover:bg-purple-500/20"
                              }`}
                            >
                              Strategy
                            </button>
                            <button
                              onClick={() => setWorkflowProject({ id: project.id, name: project.name })}
                              className="text-xs text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1 rounded-lg transition-colors"
                            >
                              Workflow
                            </button>
                            <button
                              onClick={() => setLaunchProject({ id: project.id, name: project.name })}
                              className="text-xs text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 px-3 py-1 rounded-lg transition-colors"
                            >
                              Launch Session
                            </button>
                          </td>
                        </tr>
                        {strategyProjectId === project.id && (
                          <tr>
                            <td colSpan={7} className="px-5 py-3">
                              <StrategyTree projectId={project.id} />
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Iteration workflow editor modal */}
      {workflowProject && (
        <IterationEditor
          projectId={workflowProject.id}
          projectName={workflowProject.name}
          onClose={() => setWorkflowProject(null)}
        />
      )}

      {/* Launch modal */}
      {launchProject && (
        <LaunchModal
          projectId={launchProject.id}
          projectName={launchProject.name}
          onClose={() => setLaunchProject(null)}
          onLaunched={() => {
            setLaunchProject(null);
            queryClient.invalidateQueries({ queryKey: ["sessions"] });
          }}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} />
    </div>
  );
}

// ── Iteration Workflow Editor ─────────────────────────────

function IterationEditor({
  projectId,
  projectName,
  onClose,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly onClose: () => void;
}): React.ReactElement {
  const [steps, setSteps] = useState<IterationStep[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Load steps on mount only — disable refetching so edits aren't overwritten
  const { isLoading } = useQuery({
    queryKey: ["iteration", projectId],
    queryFn: async () => {
      const data = await fetchIterationSteps(projectId);
      if (!loaded) {
        setSteps(data.steps);
        setLoaded(true);
      }
      return data;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    staleTime: Infinity,
  });

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      // Re-number IDs sequentially before saving
      const renumbered = steps.map((s, i) => ({ ...s, id: i + 1 }));
      await updateIterationSteps(projectId, renumbered);
      setSteps(renumbered);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [projectId, steps]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await resetIterationSteps(projectId);
      setSteps(data.steps);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset");
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  const moveStep = useCallback((index: number, direction: -1 | 1) => {
    setSteps((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const temp = next[index];
      next[index] = next[target];
      next[target] = temp;
      return next.map((s, i) => ({ ...s, id: i + 1 }));
    });
  }, []);

  const updateStep = useCallback((index: number, field: keyof IterationStep, value: string | boolean) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    );
  }, []);

  const addStep = useCallback(() => {
    setSteps((prev) => [
      ...prev,
      { id: prev.length + 1, label: "", description: "", gated: false },
    ]);
  }, []);

  const removeStep = useCallback((index: number) => {
    setSteps((prev) =>
      prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, id: i + 1 })),
    );
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-800 rounded-xl border border-slate-700/50 w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50">
          <div>
            <h2 className="text-lg font-semibold text-white">Iteration Workflow</h2>
            <p className="text-xs text-slate-500 mt-0.5">{projectName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {isLoading && <p className="text-sm text-slate-500">Loading...</p>}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          {success && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 text-sm text-green-400">
              Saved successfully.
            </div>
          )}

          {loaded && steps.map((step, index) => (
            <div
              key={`${step.id}-${index}`}
              className="bg-slate-900/50 border border-slate-700/30 rounded-lg p-3 flex gap-3"
            >
              {/* Order number + move buttons */}
              <div className="flex flex-col items-center gap-0.5 pt-1">
                <span className="text-xs text-slate-500 font-mono w-5 text-center">{index + 1}</span>
                <button
                  onClick={() => moveStep(index, -1)}
                  disabled={index === 0}
                  className="text-slate-500 hover:text-white disabled:opacity-20 text-xs leading-none"
                  title="Move up"
                >
                  &#9650;
                </button>
                <button
                  onClick={() => moveStep(index, 1)}
                  disabled={index === steps.length - 1}
                  className="text-slate-500 hover:text-white disabled:opacity-20 text-xs leading-none"
                  title="Move down"
                >
                  &#9660;
                </button>
              </div>

              {/* Fields */}
              <div className="flex-1 space-y-2">
                <input
                  value={step.label}
                  onChange={(e) => updateStep(index, "label", e.target.value)}
                  placeholder="Step label"
                  className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
                />
                <input
                  value={step.description}
                  onChange={(e) => updateStep(index, "description", e.target.value)}
                  placeholder="Description (optional)"
                  className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-blue-500"
                />
                <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={step.gated}
                    onChange={(e) => updateStep(index, "gated", e.target.checked)}
                    className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                  />
                  Gated (must report completion before proceeding)
                </label>
              </div>

              {/* Delete */}
              <button
                onClick={() => removeStep(index)}
                className="text-slate-500 hover:text-red-400 transition-colors text-sm self-start pt-1"
                title="Remove step"
              >
                &times;
              </button>
            </div>
          ))}

          {loaded && (
            <button
              onClick={addStep}
              className="w-full py-2 border border-dashed border-slate-600 rounded-lg text-sm text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
            >
              + Add Step
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700/50">
          <button
            onClick={handleReset}
            disabled={saving}
            className="text-xs text-slate-400 hover:text-white transition-colors disabled:opacity-50"
          >
            Reset to Default
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
