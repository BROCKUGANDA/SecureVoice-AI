import { COMPANY, PLANS, FAQ } from "@/lib/commercial";
import { siteOrigin } from "@/lib/site-origin";
import { SUPPORT_EMAIL } from "@/lib/public-config";

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
/**
 * Render a JSON-LD script element.
 *
 * JSON-LD has to be a script element with the JSON as its TEXT content, and a
 * server component cannot produce that as a React text child without React
 * escaping the quotes into `&quot;` (which is valid JSON-embedded-in-HTML but
 * parsers differ on it). So the markup is injected rather than escaped.
 *
 * The one thing that makes that safe is the escaping below: `JSON.stringify`
 * does NOT escape `<`, and an unescaped `<` inside a script element is how a
 * JSON-LD block becomes an injection vector (the classic `</script><script>`
 * payload). `<`, `>` and `&` are therefore escaped as their JSON-legal `<`
 * etc. forms, which is inert to a JSON parser and closes the hole.
 */
function JsonLdScript({ graph }: { graph: object }) {
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

/**
 * The site-wide identity graph. Mounted once in the root layout.
 *
 * Organization + WebSite only — the two nodes that are true of every page on
 * the domain, and small enough that repeating them costs nothing meaningful.
 * Everything that describes the PRODUCT (SoftwareApplication, the Offer list,
 * FAQPage) lives in `ProductJsonLd` instead, on the pages that actually show
 * that content.
 */
export function JsonLd({ origin = siteOrigin() }: { origin?: string }) {
  const orgId = `${origin}/#organization`;
  const siteId = `${origin}/#website`;

  return (
    <JsonLdScript
      graph={{
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            "@id": orgId,
            name: COMPANY.name,
            legalName: COMPANY.legalName,
            url: `${origin}/`,
            email: `mailto:${SUPPORT_EMAIL}`,
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
        ],
      }}
    />
  );
}

/**
 * The product graph — SoftwareApplication, its Offers, and the FAQ.
 *
 * Split out from `JsonLd` because the whole block was ~8 KB and was being sent
 * to every route in the app from the root layout. That is 14% of the HTML
 * payload on `/privacy`, `/terms` and `/refund`, where a `SoftwareApplication`
 * node with three `Offer`s and a full FAQ is not merely redundant but
 * misleading: it tells an answer engine that the Terms of Service page is a
 * product listing.
 *
 * `withFaq` is off on `/pricing` and on at `/`.
 *
 * The distinction is not "does this page render the questions" — it does not,
 * anywhere. No view draws the FAQ, and that is deliberate: see the note on
 * `FAQ` in `@/lib/commercial`. The answers are written to be quotable by a
 * system that has never seen this site, which is a property of the text, not of
 * the page it sits on. It is carried as data on the homepage only, which is
 * where it was before this split and the page where a buyer's questions are
 * actually being asked.
 *
 * What the split DOES remove is the copy on `/privacy`, `/terms` and `/refund`,
 * which was the wrong claim to make: a Terms of Service document carrying a
 * three-plan `Offer` list and a product FAQ tells an answer engine that the
 * legal pages are a storefront. `/pricing` keeps the `Offer` nodes because the
 * plan cards on it genuinely back those prices, and drops the FAQ because
 * nothing there is a question.
 */
export function ProductJsonLd({
  origin = siteOrigin(),
  withFaq = true,
}: {
  origin?: string;
  withFaq?: boolean;
}) {
  const orgId = `${origin}/#organization`;
  const siteId = `${origin}/#website`;
  const productId = `${origin}/#product`;

  const product = {
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
  };

  const nodes: object[] = [
    product,
    {
      "@type": "WebPage",
      "@id": `${origin}/#webpage`,
      url: `${origin}/`,
      name: `${COMPANY.name} — Real-Time Fraud Intervention`,
      isPartOf: { "@id": siteId },
      about: { "@id": productId },
      inLanguage: "en",
    },
  ];

  if (withFaq) {
    nodes.splice(1, 0, {
      "@type": "FAQPage",
      "@id": `${origin}/#faq`,
      mainEntity: FAQ.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  return (
    <JsonLdScript
      graph={{
        "@context": "https://schema.org",
        "@graph": nodes,
      }}
    />
  );
}

/**
 * The FAQ graph on its own, for the page that actually renders the questions.
 *
 * Split from `ProductJsonLd` because `/faq` is a page ABOUT the questions. It
 * needs the `FAQPage` node; it does not need a `SoftwareApplication` with three
 * offers pointing at `/pricing`, which would be a second, competing description
 * of the product on a page whose entire subject is a different one.
 *
 * `WebPage` is emitted because this is the one page where the FAQ node has a
 * real document to belong to — which is what makes the split meaningful: the
 * schema here finally describes something the visitor can actually read.
 */
export function FaqJsonLd({ origin = siteOrigin() }: { origin?: string }) {
  const siteId = `${origin}/#website`;

  return (
    <JsonLdScript
      graph={{
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "FAQPage",
            "@id": `${origin}/faq#faq`,
            isPartOf: { "@id": siteId },
            inLanguage: ["en", "ar"],
            mainEntity: FAQ.map((f) => ({
              "@type": "Question",
              name: f.q,
              acceptedAnswer: { "@type": "Answer", text: f.a },
            })),
          },
          {
            "@type": "WebPage",
            "@id": `${origin}/faq#webpage`,
            url: `${origin}/faq`,
            name: `${COMPANY.name} — FAQ`,
            isPartOf: { "@id": siteId },
            inLanguage: "en",
          },
        ],
      }}
    />
  );
}
