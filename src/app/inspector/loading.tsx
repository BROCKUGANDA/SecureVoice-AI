import { ViewLoading } from "@/components/ui/ViewLoading";

/** `/inspector` reads queue and outbox state from the database on the server. */
export default function InspectorLoading() {
  return <ViewLoading variant="table" />;
}
