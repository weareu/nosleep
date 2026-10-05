/**
 * Collapsible tree renderer for JSON payloads — the "show the shape, not the
 * blob" alternative to dumping stringified JSON in a <pre>. Objects/arrays
 * render as native <details> nodes (top two levels open), primitives inline.
 */

const MAX_STRING_PREVIEW = 200;

function Primitive({ value }: { value: unknown }): React.ReactElement {
  if (value === null) return <span className="text-slate-500">null</span>;
  switch (typeof value) {
    case "string": {
      const truncated =
        value.length > MAX_STRING_PREVIEW ? `${value.slice(0, MAX_STRING_PREVIEW)}…` : value;
      return <span className="text-emerald-300 break-all whitespace-pre-wrap">{truncated}</span>;
    }
    case "number":
      return <span className="text-amber-300">{String(value)}</span>;
    case "boolean":
      return <span className="text-purple-300">{String(value)}</span>;
    default:
      return <span className="text-slate-500">{String(value)}</span>;
  }
}

function Node({
  name,
  value,
  depth,
}: {
  name: string | null;
  value: unknown;
  depth: number;
}): React.ReactElement {
  const keyEl =
    name !== null ? <span className="text-sky-300">{name}</span> : null;

  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    const badge = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
    if (entries.length === 0) {
      return (
        <div className="pl-1">
          {keyEl}
          {keyEl ? ": " : null}
          <span className="text-slate-500">{Array.isArray(value) ? "[]" : "{}"}</span>
        </div>
      );
    }
    return (
      <details open={depth < 2} className="pl-1">
        <summary className="cursor-pointer select-none hover:bg-slate-800/50 rounded px-1 -mx-1">
          {keyEl}
          {keyEl ? " " : null}
          <span className="text-slate-500">{badge}</span>
        </summary>
        <div className="pl-4 border-l border-slate-800 ml-1">
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      </details>
    );
  }

  return (
    <div className="pl-1">
      {keyEl}
      {keyEl ? ": " : null}
      <Primitive value={value} />
    </div>
  );
}

export function JsonTree({ data }: { data: unknown }): React.ReactElement {
  return (
    <div className="bg-slate-950 border border-slate-800 rounded p-3 text-xs font-mono text-slate-300 overflow-x-auto">
      <Node name={null} value={data} depth={0} />
    </div>
  );
}
