import { COMPANY, PLANS, FAQ } from "@/lib/commercial";
import { siteOrigin } from "@/lib/site-origin";

/**
 * schema.org structured data, for answer engines.
 *
 * "AEO" (answer-engine optimisation) is mostly this file. A search engine reads
 * the rendered page; an answer engine reads whatever it can extract as data, and
 * a page whose price and product facts only exist as prose inside a client-side
 * panel gives it nothing extractable. Everything below is the same set of facts
 * the pricing page displays, in a shape a model can quote without inventing a
 * number.
 *
 * Design rules, each of which is a way the usual implementation goes wrong:
 *
 *  - **The data comes from `src/lib/commercial.ts`**, the same module the pricing
 *    page renders from. A hand-copied `price: "1490"` here and an edited one
 *    there is how a site ends up with a price its own page contradicts.
 *  - **`@id` cross-links the nodes.** Organization → WebSite → SoftwareApplication
 *    → Offer means the graph is one connected thing rather than four loose
 *    documents, which is what lets an engine resolve "who makes this product" to
 *    "SecureVoice Technologies FZ-LLC" instead of inferring it.
 *  - **Enterprise has NO price.** An `Offer` without a `price` is valid schema.org
 *    and reads as "contact the vendor". Emitting a placeholder — `0`, `null`,
 *    `9999` — turns a legitimate "custom" into a published fact, which is the
 *    single worst thing this file could do.
 *  - **Nothing is claimed that the site does not do.** No `aggregateRating`, no
 *    `review`, no invented `award`. A fabricated rating is a manual-action risk
 *    and, before that, a lie.
 *  - **`sameAs` is empty and that is deliberate** — see `COMPANY.sameAs`.
 *
 * WHY A dangerouslySetInnerHtml <script> AND NOT dangerouslySetInnerHTML TEXT
 * JSON-LD has to be a script element with the JSON as its text content, and a
 * server component cannot produce that as a React text child without React
 * escaping the quotes into `&quot;` (which is valid JSON-embedded-in-HTML but
 * parsers differ on it). So the markup is injected rather than escaped. The one
 * thing that makes that safe is the escaping below: `JSON.stringify` does NOT
 * escape `<`, and an unescaped `<` inside a script element is how a JSON-LD block
 * becomes an injection vector (the classic `</script><script>` payload). `<`, `>`
 * and `&` are therefore escaped as their JSON-legal `<` etc. forms,
 * which is inert to a JSON parser and closes the hole.
 */
export function JsonLd({ origin = siteOrigin() }: { origin?: string }) {
  const orgId = `${origin}/#organization`;
  const siteId = `${origin}/#website`;
  const productId = `${origin}/#product`;

  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: COMPANY.name,
        legalName: COMPANY.legalName,
        url: `${origin}/`,
        email: `mailto:${process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "otemaach@gmail.com"}`,
        foundingDate: COMPANY.foundingYear,
        description:
          "Real-time voice fraud-intervention platform for banks and insurers in the United Arab Emirates.",
        address: {
          "@type": "PostalAddress",
          addressLocality: COMPANY.city,
          addressRegion: "Dubai",
          addressCountry: COMPANY.countryCode,
        },
        ...(COMPANY.sameAs.length ? { sameAs: [...COMPANY.sameAs] } : {}),
      },
      {
        "@type": "WebSite",
        "@id": siteId,
        url: `${origin}/`,
        name: COMPANY.name,
        inLanguage: "en",
        publisher: { "@id": orgId },
      },
      {
        "@type": "SoftwareApplication",
        "@id": productId,
        name: `${COMPANY.name} — Real-Time Fraud Intervention`,
        applicationCategory: "FinanceApplication",
        applicationSubCategory: "Fraud prevention",
        operatingSystem: "Web, Docker, Kubernetes",
        url: `${origin}/`,
        publisher: { "@id": orgId },
        // Deliberate: this is a commercial product, and an engine asked "is
        // there a free version" should hear no.
        isAccessibleForFree: false,
        inLanguage: ["en", "ar", "hi", "ur", "fr", "sw"],
        featureList: [
          "Outbound AI voice intervention within 60 seconds of a fraud signal",
          "Identity verification that never captures a PIN, OTP or full card number",
          "Card freeze and transfer hold, staged and reversible",
          "Tamper-evident audit chain",
          "Six languages: Arabic, English, Hindi, Urdu, French, Swahili",
          "In-VPC deployment with bring-your-own-keys",
          "CBUAE-aligned audit pack",
        ],
        offers: PLANS.map((plan) => ({
          "@type": "Offer",
          name: plan.name,
          description: plan.offer.description,
          availability: plan.offer.availability,
          url: `${origin}/pricing`,
          seller: { "@id": orgId },
          // `priceSpecification` only when there IS a price. Emitting one with a
          // placeholder for the Enterprise tier would publish "0 USD/month" as
          // an Enterprise price, which is worse than publishing nothing.
          ...(plan.offer.price
            ? {
                price: plan.offer.price,
                priceCurrency: plan.offer.priceCurrency,
                priceSpecification: {
                  "@type": "UnitPriceSpecification",
                  price: plan.offer.price,
                  priceCurrency: plan.offer.priceCurrency,
                  unitText: "MONTH",
                  referenceQuantity: {
                    "@type": "QuantitativeValue",
                    value: 1,
                    unitCode: "MON",
                  },
                },
              }
            : {}),
        })),
      },
      {
        "@type": "FAQPage",
        "@id": `${origin}/#faq`,
        mainEntity: FAQ.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
      {
        "@type": "WebPage",
        "@id": `${origin}/#webpage`,
        url: `${origin}/`,
        name: `${COMPANY.name} — Real-Time Fraud Intervention`,
        isPartOf: { "@id": siteId },
        about: { "@id": productId },
        inLanguage: "en",
      },
    ],
  };

  // `<` is escaped as `<`: inert to a JSON parser, and it means the string
  // can never contain the `</script>` sequence that would close this element
  // early. `>` and `&` are escaped for the same reason so no transformation
  // between here and the parser can reintroduce one.
  const json = JSON.stringify(graph)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
