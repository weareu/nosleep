interface OrgBadgeProps {
  readonly slug: string;
  readonly name: string;
  readonly color: string;
  readonly size?: "sm" | "md";
}

export function OrgBadge({
  slug: _slug,
  name,
  color,
  size = "sm",
}: OrgBadgeProps): React.ReactElement {
  const sizeClasses = size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${sizeClasses}`}
      style={{
        backgroundColor: `${color}20`,
        color,
        border: `1px solid ${color}40`,
      }}
    >
      <span
        className="mr-1.5 h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {name}
    </span>
  );
}
