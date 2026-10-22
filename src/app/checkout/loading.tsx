import { ViewLoading } from "@/components/ui/ViewLoading";

/** `/checkout` awaits the Paddle catalog and the tenant's wallet. */
export default function CheckoutLoading() {
  return <ViewLoading variant="panel" />;
}
