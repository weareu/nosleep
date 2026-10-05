/**
 * Shared markdown renderer for dashboard cards and detail pages. Compact,
 * dark-theme styled. Use anywhere thought/escalation/session prose is shown —
 * raw `## **markdown**` in a card is a bug, not a style.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}): React.ReactElement {
  return (
    <div className={`nosleep-markdown text-sm leading-relaxed ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="text-base font-bold text-slate-100 mt-3 mb-1 first:mt-0" {...p} />,
          h2: (p) => <h2 className="text-sm font-bold text-slate-100 mt-3 mb-1 first:mt-0" {...p} />,
          h3: (p) => <h3 className="text-sm font-semibold text-slate-200 mt-2 mb-1 first:mt-0" {...p} />,
          h4: (p) => <h4 className="text-sm font-semibold text-slate-300 mt-2 mb-1 first:mt-0" {...p} />,
          p: (p) => <p className="my-1 first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="list-disc pl-5 my-1 space-y-0.5" {...p} />,
          ol: (p) => <ol className="list-decimal pl-5 my-1 space-y-0.5" {...p} />,
          li: (p) => <li className="marker:text-slate-500" {...p} />,
          a: (p) => (
            <a
              className="text-blue-400 hover:underline break-all"
              target="_blank"
              rel="noopener noreferrer"
              {...p}
            />
          ),
          strong: (p) => <strong className="font-semibold text-slate-100" {...p} />,
          blockquote: (p) => (
            <blockquote className="border-l-2 border-slate-600 pl-3 my-1 text-slate-400" {...p} />
          ),
          code: ({ className: cls, children: c, ...rest }) => {
            const isBlock = /language-/.test(cls ?? "");
            return isBlock ? (
              <code className={`block text-xs ${cls ?? ""}`} {...rest}>{c}</code>
            ) : (
              <code className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5 text-xs font-mono text-amber-300" {...rest}>
                {c}
              </code>
            );
          },
          pre: (p) => (
            <pre
              className="bg-slate-950 border border-slate-800 rounded p-2 my-1 overflow-x-auto text-xs"
              {...p}
            />
          ),
          table: (p) => (
            <div className="overflow-x-auto my-1">
              <table className="text-xs border-collapse" {...p} />
            </div>
          ),
          th: (p) => <th className="border border-slate-700 px-2 py-1 bg-slate-800 text-left" {...p} />,
          td: (p) => <td className="border border-slate-800 px-2 py-1" {...p} />,
          hr: () => <hr className="border-slate-800 my-2" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
