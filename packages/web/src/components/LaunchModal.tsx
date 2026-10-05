import { useState } from "react";
import { launchSession } from "../lib/api";

interface LaunchModalProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly onClose: () => void;
  readonly onLaunched: () => void;
}

export function LaunchModal({
  projectId,
  projectName,
  onClose,
  onLaunched,
}: LaunchModalProps): React.ReactElement {
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addCriterion = () => setCriteria((prev) => [...prev, ""]);

  const updateCriterion = (index: number, value: string) => {
    setCriteria((prev) => prev.map((c, i) => (i === index ? value : c)));
  };

  const removeCriterion = (index: number) => {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const filteredCriteria = criteria.filter((c) => c.trim().length > 0);
    if (!goal.trim() || filteredCriteria.length === 0) {
      setError("Goal and at least one acceptance criterion are required.");
      return;
    }

    setLoading(true);
    try {
      await launchSession({
        projectId,
        goal: goal.trim(),
        acceptanceCriteria: filteredCriteria,
      });
      onLaunched();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch session");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4">
        <div className="px-6 py-4 border-b border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Launch Session</h2>
            <p className="text-sm text-slate-400">{projectName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Goal</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none"
              placeholder="Describe what this session should accomplish..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Acceptance Criteria
            </label>
            <div className="space-y-2">
              {criteria.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={c}
                    onChange={(e) => updateCriterion(i, e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                    placeholder={`Criterion ${i + 1}`}
                  />
                  {criteria.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeCriterion(i)}
                      className="text-slate-500 hover:text-red-400 transition-colors px-1"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addCriterion}
              className="mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              + Add criterion
            </button>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
            >
              {loading ? "Launching..." : "Launch"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
