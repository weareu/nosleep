import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchHooksStatus,
  installHooks,
  uninstallHooks,
  type HookStatus,
  type HookActionResult,
} from "../lib/api";

// --- Toast notification ---

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly type: "success" | "error";
}

let toastIdCounter = 0;

function useToast() {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const addToast = useCallback((message: string, type: "success" | "error") => {
    const id = ++toastIdCounter;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return { toasts, addToast };
}

function ToastContainer({ toasts }: { readonly toasts: readonly Toast[] }): React.ReactElement {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg transition-all animate-slide-in ${
            toast.type === "success"
              ? "bg-green-600/90 text-white"
              : "bg-red-600/90 text-white"
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}

// --- Hook status badge for project rows ---

export function HookBadge({
  projectId,
  hookStatuses,
  onInstall,
  onUninstall,
  isLoading,
}: {
  readonly projectId: string;
  readonly hookStatuses: readonly HookStatus[] | undefined;
  readonly onInstall: (projectId: string) => void;
  readonly onUninstall: (projectId: string) => void;
  readonly isLoading: boolean;
}): React.ReactElement {
  const status = hookStatuses?.find((h) => h.projectId === projectId);

  if (!status) {
    return (
      <span className="text-xs text-slate-600">--</span>
    );
  }

  return (
    <button
      onClick={() =>
        status.installed ? onUninstall(projectId) : onInstall(projectId)
      }
      disabled={isLoading}
      className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
        status.installed
          ? "bg-green-500/15 text-green-400 hover:bg-green-500/25"
          : "bg-slate-700/50 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
      } ${isLoading ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
      title={status.installed ? "Click to uninstall hooks" : "Click to install hooks"}
    >
      {status.installed ? "Hooks On" : "No Hooks"}
    </button>
  );
}

// --- Global action bar ---

export function HookGlobalActions({
  onInstallAll,
  onUninstallAll,
  isLoading,
}: {
  readonly onInstallAll: () => void;
  readonly onUninstallAll: () => void;
  readonly isLoading: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onInstallAll}
        disabled={isLoading}
        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
          isLoading
            ? "bg-slate-700 text-slate-500 cursor-wait"
            : "bg-green-600/20 text-green-400 hover:bg-green-600/30"
        }`}
      >
        Install Hooks: All
      </button>
      <button
        onClick={onUninstallAll}
        disabled={isLoading}
        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
          isLoading
            ? "bg-slate-700 text-slate-500 cursor-wait"
            : "bg-red-600/10 text-red-400 hover:bg-red-600/20"
        }`}
      >
        Uninstall All
      </button>
    </div>
  );
}

// --- Per-org action button ---

export function HookOrgAction({
  orgId,
  onInstall,
  isLoading,
}: {
  readonly orgId: string;
  readonly onInstall: (orgId: string) => void;
  readonly isLoading: boolean;
}): React.ReactElement {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onInstall(orgId);
      }}
      disabled={isLoading}
      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
        isLoading
          ? "bg-slate-700 text-slate-500 cursor-wait"
          : "bg-blue-600/15 text-blue-400 hover:bg-blue-600/25"
      }`}
    >
      Install Hooks
    </button>
  );
}

// --- Main hook for all hook management state ---

export function useHookManagement() {
  const queryClient = useQueryClient();
  const { toasts, addToast } = useToast();

  const { data: hookStatuses } = useQuery<HookStatus[]>({
    queryKey: ["hooks-status"],
    queryFn: () => fetchHooksStatus(),
  });

  const handleResult = useCallback(
    (action: string, result: HookActionResult) => {
      const count = result.installed ?? result.uninstalled ?? 0;
      if (result.errors.length > 0) {
        addToast(
          `${action}: ${count} succeeded, ${result.errors.length} failed`,
          "error",
        );
      } else {
        addToast(`${action}: ${count} project${count !== 1 ? "s" : ""}`, "success");
      }
      queryClient.invalidateQueries({ queryKey: ["hooks-status"] });
    },
    [addToast, queryClient],
  );

  const handleError = useCallback(
    (err: unknown) => {
      addToast(
        err instanceof Error ? err.message : "Hook operation failed",
        "error",
      );
    },
    [addToast],
  );

  const installMutation = useMutation({
    mutationFn: (params: { scope: "global" | "org" | "project"; orgId?: string; projectId?: string }) =>
      installHooks(params.scope, params.orgId, params.projectId),
    onSuccess: (result) => handleResult("Installed hooks", result),
    onError: handleError,
  });

  const uninstallMutation = useMutation({
    mutationFn: (params: { scope: "global" | "org" | "project"; orgId?: string; projectId?: string }) =>
      uninstallHooks(params.scope, params.orgId, params.projectId),
    onSuccess: (result) => handleResult("Uninstalled hooks", result),
    onError: handleError,
  });

  const isLoading = installMutation.isPending || uninstallMutation.isPending;

  const installAll = useCallback(() => {
    installMutation.mutate({ scope: "global" });
  }, [installMutation]);

  const uninstallAll = useCallback(() => {
    uninstallMutation.mutate({ scope: "global" });
  }, [uninstallMutation]);

  const installOrg = useCallback(
    (orgId: string) => {
      installMutation.mutate({ scope: "org", orgId });
    },
    [installMutation],
  );

  const installProject = useCallback(
    (projectId: string) => {
      installMutation.mutate({ scope: "project", projectId });
    },
    [installMutation],
  );

  const uninstallProject = useCallback(
    (projectId: string) => {
      uninstallMutation.mutate({ scope: "project", projectId });
    },
    [uninstallMutation],
  );

  return {
    hookStatuses,
    isLoading,
    installAll,
    uninstallAll,
    installOrg,
    installProject,
    uninstallProject,
    toasts,
    ToastContainer,
  };
}
