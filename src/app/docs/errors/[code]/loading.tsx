import { ViewLoading } from "@/components/ui/ViewLoading";

/** `/docs/errors/[code]` looks the code up server-side, so the prose frame
 *  shimmers rather than the page arriving after a blank. */
export default function ErrorCodeLoading() {
  return <ViewLoading variant="page" />;
}
