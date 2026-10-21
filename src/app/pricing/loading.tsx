import { ViewLoading } from "@/components/ui/ViewLoading";

/**
 * `/pricing` awaits the live plan catalogue and entitlements, so without this the
 * route holds the previous screen until the server component resolves. Card
 * shapes, because that is what arrives.
 */
export default function PricingLoading() {
  return <ViewLoading variant="panel" />;
}
