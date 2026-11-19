import { ViewLoading } from "@/components/ui/ViewLoading";

/**
 * Route-level fallback for /console/moderation.
 *
 * The page is an async server component that awaits the session guard and
 * several tenant-scoped queries; without a loading boundary the route-sweep
 * gate flags it as a data-fetching segment that can suspend with no fallback.
 * Uses the shared `ViewLoading` skeleton — per-route skeletons are how one of
 * them ends up announcing nothing to a screen reader.
 */
export default function ModerationLoading() {
  return <ViewLoading variant="table" />;
}
