/**
 * Brain Bookmarklet generator. Lets the user configure server URL, API key,
 * org, project, and capture mode, then drags the generated link to their
 * bookmarks bar. Clicking the bookmark on any page POSTs the page's URL to
 * /api/brain/capture-url.
 */

import { useMemo, useState } from "react";
import { useOrgProject } from "../../components/OrgProjectPicker";

const DEFAULT_PROJECT = "_org_level";

function defaultServer(): string {
  // The web app proxies /api → server, but a bookmarklet runs on arbitrary
  // pages and needs the absolute URL. Default to current origin so dev/local
  // setups Just Work.
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3777";
}

function buildBookmarklet(args: {
  server: string;
  apiKey: string;
  orgId: string;
  projectId: string;
  mode: "ref" | "full";
  promptNote: boolean;
}): string {
  // Build the bookmarklet body. We embed the config inline (the user is
  // generating it for themselves). Strings are JSON-encoded then injected.
  const cfg = JSON.stringify({
    server: args.server.replace(/\/+$/, ""),
    apiKey: args.apiKey,
    orgId: args.orgId,
    projectId: args.projectId,
    mode: args.mode,
    promptNote: args.promptNote,
  });

  const fnSource = `(function(){
    var c = ${cfg};
    var u = location.href;
    var t = document.title;
    var sel = (window.getSelection && String(window.getSelection())) || "";
    var note = c.promptNote ? prompt("Note (optional):", sel || "") : (sel || "");
    if (note === null) return; // user cancelled
    var body = {
      url: u,
      org_id: c.orgId,
      project_id: c.projectId,
      mode: c.mode,
      note: note || undefined,
      tags: ["bookmarklet"]
    };
    fetch(c.server + "/api/brain/capture-url", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": c.apiKey
      },
      body: JSON.stringify(body)
    }).then(function(r){
      if (r.ok) {
        var n = document.createElement("div");
        n.textContent = "✓ Captured: " + t;
        n.style.cssText = "position:fixed;top:12px;right:12px;background:#10b981;color:#fff;padding:10px 14px;border-radius:6px;font:14px sans-serif;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,.3)";
        document.body.appendChild(n);
        setTimeout(function(){ n.remove(); }, 2500);
      } else {
        r.text().then(function(txt){ alert("Capture failed: " + r.status + " " + txt); });
      }
    }).catch(function(e){ alert("Capture error: " + e); });
  })();`;

  // Strip indentation + collapse newlines to one line. Avoid stripping
  // newlines inside string literals — our source has none above.
  const oneLine = fnSource.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
  return "javascript:" + encodeURI(oneLine);
}

export function BrainBookmarklet(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const projectId = scope.projectId;
  const [server, setServer] = useState(defaultServer);
  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState<"ref" | "full">("full");
  const [promptNote, setPromptNote] = useState(true);
  const [copied, setCopied] = useState(false);

  const bookmarklet = useMemo(
    () =>
      buildBookmarklet({
        server,
        apiKey,
        orgId,
        projectId,
        mode,
        promptNote,
      }),
    [server, apiKey, orgId, projectId, mode, promptNote],
  );

  function copy() {
    navigator.clipboard.writeText(bookmarklet).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => {
        // Browsers may block clipboard on insecure origins; ignore.
      },
    );
  }

  return (
    <div className="p-6 space-y-6 text-slate-200 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Capture Bookmarklet</h1>
        <p className="text-sm text-slate-400 mt-1">
          Configure your server, API key, and target project, then drag the
          generated link to your browser's bookmarks bar. Clicking it on any
          page captures that URL into the brain.
        </p>
      </div>

      <section className="bg-slate-800/40 border border-slate-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold">Configuration</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Server URL">
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              className={inputCls}
              placeholder="http://localhost:3777"
            />
          </Field>
          <Field label="API Key">
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={inputCls}
              placeholder="x-api-key value"
              type="password"
              autoComplete="off"
            />
          </Field>
          <Field label="Scope">
            <div className="px-3 py-2 bg-slate-900 border border-slate-700 rounded text-sm text-slate-300">
              {orgId}{projectId === "_org_level" ? " · org-level" : ` · ${projectId}`}
              <p className="text-[10px] text-slate-500 mt-1">
                Pick a different org/project from the picker in the header.
              </p>
            </div>
          </Field>
          <Field label="Mode">
            <div className="flex rounded border border-slate-700 overflow-hidden">
              {(["full", "ref"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 px-3 py-2 text-xs ${
                    mode === m
                      ? "bg-blue-600 text-white"
                      : "bg-slate-900 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {m === "full" ? "Full (Readability)" : "Ref only"}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Note prompt">
            <label className="flex items-center gap-2 px-3 py-2 bg-slate-900 border border-slate-700 rounded text-sm text-slate-300">
              <input
                type="checkbox"
                checked={promptNote}
                onChange={(e) => setPromptNote(e.target.checked)}
              />
              Ask for an inline note when triggered
            </label>
          </Field>
        </div>
      </section>

      <section className="bg-slate-800/40 border border-slate-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold">Drag this to your bookmarks bar</h2>
        <div className="flex items-center gap-3">
          <a
            href={bookmarklet}
            onClick={(e) => e.preventDefault()}
            draggable
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold inline-block"
          >
            📌 Capture to Brain
          </a>
          <button
            type="button"
            onClick={copy}
            className="px-3 py-2 text-sm rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
          >
            {copied ? "Copied!" : "Copy source"}
          </button>
        </div>
        <p className="text-xs text-slate-500">
          On Firefox/Chrome/Safari: drag the blue button onto your bookmarks
          toolbar. On mobile, copy the source and add it as a bookmark with
          the JavaScript URL pasted as the address.
        </p>
      </section>

      <section className="bg-slate-800/40 border border-slate-800 rounded-lg p-4 space-y-2">
        <h2 className="text-sm font-semibold">Source preview</h2>
        <pre className="bg-slate-950 border border-slate-800 p-3 rounded overflow-x-auto text-[10px] text-slate-400 whitespace-pre-wrap break-all">
          {bookmarklet}
        </pre>
      </section>

      <section className="bg-slate-800/40 border border-slate-800 rounded-lg p-4 text-sm text-slate-300 space-y-2">
        <h2 className="text-sm font-semibold">Notes</h2>
        <ul className="list-disc list-inside space-y-1 text-slate-400">
          <li>
            The bookmarklet stores the API key inline. Treat the bookmark like
            any other secret — anyone with access to your bookmarks bar can
            read it.
          </li>
          <li>
            For multi-org setups, generate one bookmarklet per org/project and
            label them in your bookmarks bar.
          </li>
          <li>
            <strong>Ref</strong> stores the URL + og-tags only.{" "}
            <strong>Full</strong> additionally fetches and indexes the article
            via Readability.
          </li>
          <li>
            If the page has selected text when triggered, the selection is
            pre-filled into the note prompt.
          </li>
        </ul>
      </section>
    </div>
  );
}

const inputCls =
  "bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-full";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
