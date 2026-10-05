/**
 * Phase 12 (UI review H2 + H5) — lazy-loaded image thumbnail for Brain
 * surfaces. Defers fetching the artifact body until the tile scrolls
 * into view, then renders a data URI from the base64 content.
 *
 * Why not <img src="/api/brain/artifacts/.../raw"> directly? The API is
 * x-api-key-protected and <img> tags can't add headers, so we go through
 * the JS auth path that the rest of the app uses. React Query caches the
 * artifact response, so navigating away and back is free.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { brainGetArtifact } from "../lib/brainApi";

interface LazyThumbnailProps {
  readonly hash: string;
  readonly orgId: string;
  /** Override the alt text — defaults to the hash prefix. */
  readonly alt?: string;
  /** Square aspect by default; pass "video" for 16:9 etc. */
  readonly aspect?: "square" | "video" | "auto";
  /** Outer wrapper className — pass any tailwind sizing here. */
  readonly className?: string;
  /** Hint for object-fit — "cover" crops, "contain" fits. Default cover. */
  readonly fit?: "cover" | "contain";
}

export function LazyThumbnail({
  hash,
  orgId,
  alt,
  aspect = "square",
  className = "",
  fit = "cover",
}: LazyThumbnailProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView || !ref.current) return;
    const node = ref.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["brain-artifact-content", orgId, hash],
    queryFn: () => brainGetArtifact(hash, orgId, []),
    enabled: inView,
    staleTime: 5 * 60 * 1000,
  });

  const aspectClass =
    aspect === "square"
      ? "aspect-square"
      : aspect === "video"
        ? "aspect-video"
        : "";
  const fitClass = fit === "cover" ? "object-cover" : "object-contain";
  // For fixed-aspect tiles the inner element fills the locked-aspect box;
  // for aspect="auto" (e.g. the lightbox) we let the image flow at its
  // intrinsic ratio bounded by the wrapper's max-w/max-h, otherwise an
  // auto-height parent collapses h-full to zero and nothing renders.
  const fillClass = aspect === "auto" ? "max-w-full max-h-full" : "w-full h-full";

  let body: React.ReactNode;
  if (!inView || isLoading) {
    body = (
      <div
        className={`bg-slate-900 animate-pulse ${aspect === "auto" ? "w-full aspect-square" : "w-full h-full"}`}
      />
    );
  } else if (
    isError ||
    !data ||
    data.content_encoding !== "base64" ||
    !data.content
  ) {
    body = (
      <div
        className={`bg-slate-900 flex items-center justify-center text-slate-700 ${aspect === "auto" ? "w-full aspect-square" : "w-full h-full"}`}
      >
        <BrokenIcon />
      </div>
    );
  } else {
    const mime = data.content_type ?? "image/png";
    body = (
      <img
        src={`data:${mime};base64,${data.content}`}
        alt={alt ?? hash.slice(0, 12)}
        loading="lazy"
        className={`${fillClass} ${fitClass}`}
      />
    );
  }

  return (
    <div
      ref={ref}
      className={`overflow-hidden ${aspectClass} ${className}`.trim()}
    >
      {body}
    </div>
  );
}

function BrokenIcon(): React.ReactElement {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        d="M4 16l4.5-4.5 3 3L16 9l4 4M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm10 4a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"
      />
    </svg>
  );
}
