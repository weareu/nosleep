import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { BrainLayout, BrainAdminLayout } from "./components/BrainLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Dashboard } from "./pages/Dashboard";
import { SessionDetail } from "./pages/SessionDetail";
import { Projects } from "./pages/Projects";
import { Alerts } from "./pages/Alerts";
import { TokenUsage } from "./pages/TokenUsage";
import { StrategyPage } from "./pages/StrategyPage";
import { StrategyGraphView } from "./pages/StrategyGraphView";
import { Coordination } from "./pages/Coordination";
import { Metrics } from "./pages/Metrics";

// Brain pages — lazy-loaded so the dashboard shell + non-brain pages
// don't pay the cost of d3-force, recharts, etc. on first paint.
const BrainHub = lazy(() =>
  import("./pages/brain/BrainHub").then((m) => ({ default: m.BrainHub })),
);
const BrainGraph = lazy(() =>
  import("./pages/brain/BrainGraph").then((m) => ({ default: m.BrainGraph })),
);
const BrainTimeline = lazy(() =>
  import("./pages/brain/BrainTimeline").then((m) => ({ default: m.BrainTimeline })),
);
const BrainSearch = lazy(() =>
  import("./pages/brain/BrainSearch").then((m) => ({ default: m.BrainSearch })),
);
const BrainArchive = lazy(() =>
  import("./pages/brain/BrainArchive").then((m) => ({ default: m.BrainArchive })),
);
const BrainSession = lazy(() =>
  import("./pages/brain/BrainSession").then((m) => ({ default: m.BrainSession })),
);
const BrainArtifact = lazy(() =>
  import("./pages/brain/BrainArtifact").then((m) => ({ default: m.BrainArtifact })),
);
const BrainThoughts = lazy(() =>
  import("./pages/brain/BrainThoughts").then((m) => ({ default: m.BrainThoughts })),
);
const BrainThought = lazy(() =>
  import("./pages/brain/BrainThought").then((m) => ({ default: m.BrainThought })),
);
const BrainImages = lazy(() =>
  import("./pages/brain/BrainImages").then((m) => ({ default: m.BrainImages })),
);
const BrainCapture = lazy(() =>
  import("./pages/brain/BrainCapture").then((m) => ({ default: m.BrainCapture })),
);
const BrainCode = lazy(() =>
  import("./pages/brain/BrainCode").then((m) => ({ default: m.BrainCode })),
);
const BrainCompare = lazy(() =>
  import("./pages/brain/BrainCompare").then((m) => ({ default: m.BrainCompare })),
);
const BrainBookmarklet = lazy(() =>
  import("./pages/brain/BrainBookmarklet").then((m) => ({ default: m.BrainBookmarklet })),
);
const BrainEntity = lazy(() =>
  import("./pages/brain/BrainEntity").then((m) => ({ default: m.BrainEntity })),
);

// Admin pages — heaviest deps (recharts) live here.
const BrainAdminDashboard = lazy(() =>
  import("./pages/admin/brain/BrainAdminDashboard").then((m) => ({
    default: m.BrainAdminDashboard,
  })),
);
const BrainAdminMetrics = lazy(() =>
  import("./pages/admin/brain/BrainAdminMetrics").then((m) => ({
    default: m.BrainAdminMetrics,
  })),
);
const BrainAdminEvents = lazy(() =>
  import("./pages/admin/brain/BrainAdminEvents").then((m) => ({
    default: m.BrainAdminEvents,
  })),
);
const BrainAdminQueryLogs = lazy(() =>
  import("./pages/admin/brain/BrainAdminQueryLogs").then((m) => ({
    default: m.BrainAdminQueryLogs,
  })),
);
const BrainAdminExtractors = lazy(() =>
  import("./pages/admin/brain/BrainAdminExtractors").then((m) => ({
    default: m.BrainAdminExtractors,
  })),
);
const BrainAdminConfig = lazy(() =>
  import("./pages/admin/brain/BrainAdminConfig").then((m) => ({
    default: m.BrainAdminConfig,
  })),
);
const BrainAdminSuggestions = lazy(() =>
  import("./pages/admin/brain/BrainAdminSuggestions").then((m) => ({
    default: m.BrainAdminSuggestions,
  })),
);
const BrainAdminMergeQueue = lazy(() =>
  import("./pages/admin/brain/BrainAdminMergeQueue").then((m) => ({
    default: m.BrainAdminMergeQueue,
  })),
);

function PageFallback(): React.ReactElement {
  return (
    <div className="p-6 text-slate-500 text-sm">loading…</div>
  );
}

/** Wraps a lazy page in Suspense + an ErrorBoundary scoped to the route. */
function GuardedPage({
  children,
  scope,
}: {
  children: React.ReactNode;
  scope?: string;
}): React.ReactElement {
  return (
    <ErrorBoundary scope={scope}>
      <Suspense fallback={<PageFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

export function App(): React.ReactElement {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="sessions/:id" element={<SessionDetail />} />
        <Route path="projects" element={<Projects />} />
        <Route path="coordination" element={<Coordination />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="tokens" element={<TokenUsage />} />
        <Route path="metrics" element={<Metrics />} />
        <Route path="strategy" element={<StrategyPage />} />
        <Route path="strategy/graph" element={<StrategyGraphView />} />

        <Route path="brain" element={<BrainLayout />}>
          <Route index element={<GuardedPage scope="brain/hub"><BrainHub /></GuardedPage>} />
          <Route path="graph" element={<GuardedPage scope="brain/graph"><BrainGraph /></GuardedPage>} />
          <Route path="timeline" element={<GuardedPage scope="brain/timeline"><BrainTimeline /></GuardedPage>} />
          <Route path="search" element={<GuardedPage scope="brain/search"><BrainSearch /></GuardedPage>} />
          <Route path="archive" element={<GuardedPage scope="brain/archive"><BrainArchive /></GuardedPage>} />
          <Route path="thoughts" element={<GuardedPage scope="brain/thoughts"><BrainThoughts /></GuardedPage>} />
          <Route path="images" element={<GuardedPage scope="brain/images"><BrainImages /></GuardedPage>} />
          <Route path="code" element={<GuardedPage scope="brain/code"><BrainCode /></GuardedPage>} />
          <Route path="compare" element={<GuardedPage scope="brain/compare"><BrainCompare /></GuardedPage>} />
          <Route path="bookmarklet" element={<GuardedPage scope="brain/capture"><BrainBookmarklet /></GuardedPage>} />
          <Route path="capture" element={<GuardedPage scope="brain/capture"><BrainCapture /></GuardedPage>} />
          {/* Detail pages now nested so they inherit the BrainLayout
              shell — top tabs, org/project picker, and a consistent
              return path via the "Hub" tab. */}
          <Route path="session/:sessionId" element={<GuardedPage scope="brain/session"><BrainSession /></GuardedPage>} />
          <Route path="artifact/:hash" element={<GuardedPage scope="brain/artifact"><BrainArtifact /></GuardedPage>} />
          <Route path="thought/:id" element={<GuardedPage scope="brain/thought"><BrainThought /></GuardedPage>} />
          <Route path="entity/:id" element={<GuardedPage scope="brain/entity"><BrainEntity /></GuardedPage>} />
        </Route>

        <Route path="admin/brain" element={<BrainAdminLayout />}>
          <Route index element={<GuardedPage scope="admin/brain"><BrainAdminDashboard /></GuardedPage>} />
          <Route path="metrics" element={<GuardedPage scope="admin/brain/metrics"><BrainAdminMetrics /></GuardedPage>} />
          <Route path="events" element={<GuardedPage scope="admin/brain/events"><BrainAdminEvents /></GuardedPage>} />
          <Route path="query-logs" element={<GuardedPage scope="admin/brain/query-logs"><BrainAdminQueryLogs /></GuardedPage>} />
          <Route path="extractors" element={<GuardedPage scope="admin/brain/extractors"><BrainAdminExtractors /></GuardedPage>} />
          <Route path="config" element={<GuardedPage scope="admin/brain/config"><BrainAdminConfig /></GuardedPage>} />
          <Route path="suggestions" element={<GuardedPage scope="admin/brain/suggestions"><BrainAdminSuggestions /></GuardedPage>} />
          <Route path="merge-queue" element={<GuardedPage scope="admin/brain/merge-queue"><BrainAdminMergeQueue /></GuardedPage>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
