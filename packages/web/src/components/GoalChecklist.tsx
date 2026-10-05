interface CriterionItem {
  readonly criterion?: string;
  readonly description?: string;
  readonly status?: "met" | "not_met" | "partial";
  readonly met?: boolean;
}

interface GoalChecklistProps {
  readonly criteria: readonly CriterionItem[];
}

const STATUS_CONFIG: Record<string, { icon: string; color: string }> = {
  met: { icon: "\u2713", color: "text-green-400" },
  partial: { icon: "\u25D1", color: "text-yellow-400" },
  not_met: { icon: "\u2717", color: "text-red-400" },
};

export function GoalChecklist({ criteria }: GoalChecklistProps): React.ReactElement {
  return (
    <ul className="space-y-1.5">
      {criteria.map((item, idx) => {
        const status = item.status ?? (item.met ? "met" : "not_met");
        const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.not_met;
        const text = item.criterion ?? item.description ?? "";

        return (
          <li key={idx} className="flex items-start gap-2 text-sm">
            <span className={`flex-shrink-0 font-mono ${config.color}`}>
              {config.icon}
            </span>
            <span className="text-slate-300">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}
