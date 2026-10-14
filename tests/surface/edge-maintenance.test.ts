/**
 * The maintenance page is an EDGE guarantee, so its proof has to read the
 * Caddyfile. Nothing in the app's own test suite can catch any of this: when the
 * `app` container is the thing that is down, `src/app/error.tsx` cannot render —
 * there is no origin response to render against — and the visitor is left with
 * Caddy's bare error text. So the behaviour worth protecting lives in this file's
 * directives, and a text assertion is the only harness that can see them.
 *
 * The properties, and the failure each one prevents:
 *
 *  1. BOTH outage shapes are covered. `handle_errors` answers the case where the
 *     origin never replied (stopped container, crash loop, connection refused);
 *     `handle_response` answers the case where it replied with a status meaning
 *     it cannot serve. Caddy's own docs say a reverse_proxy that "may write a
 *     response with an HTTP status which is classified as an error … will not
 *     trigger the error routes" — so either hook alone leaves half of an outage
 *     showing a raw error page, and a config that keeps only one of them passes
 *     a test that looks reasonable.
 *  2. 503 with `Retry-After`, never 200. A 200 is the worst thing the edge can
 *     say during an outage: an uptime probe reports healthy and a crawler
 *     indexes the maintenance page over the page it replaced. `respond` with no
 *     status code answers 200 in a plain route, so the status is asserted on
 *     every branch rather than assumed from the copy.
 *  3. OUTAGE-ONLY. The rule keys on 502/503. A 500 is the application's own
 *     defect with a digest and a Sentry event; a 4xx is a legitimate auth or
 *     validation answer that a bank's client parses. Masking either with a
 *     maintenance page would let the edge lie about what the origin said, which
 *     is how an incident gets closed by a deploy nobody made.
 *  4. The probes are NOT swallowed. `/api/health` and `/api/readyz` must keep
 *     the raw answer, because `/api/readyz` answering 503 is how ADR-008's
 *     graceful drain signals "instance leaving rotation"
 *     (scripts/server-preload.ts). This is the same class of defect
 *     probe-budget.test.ts exists for — a 429 on that path made a healthy
 *     origin look unhealthy; a maintenance page would make a real outage look
 *     planned. So the exclusion list is compared against PROBE_PATHS and against
 *     the file's own `health_uri` values, across three files.
 *  5. The page does not claim the whole product is down. The voice path runs in
 *     `voice-stream-worker`/`dial-worker` and bank deliveries drain from
 *     `outbox-worker`; the copy has to say so, and the machine surfaces must not
 *     be answered with it at all.
 *  6. The rule cannot shadow the routing it sits next to. `handle_errors` is an
 *     error route, not a site route, and the page is reached only through the
 *     two hooks — which is why every `import maintenance_page` is checked for
 *     its enclosing block. A stray top-level import would answer EVERY request
 *     with a maintenance page while validating cleanly.
 *
 * The Caddyfile is parsed as text on purpose: `caddy validate` proves syntax, not
 * intent, and it proves nothing at all about a status code that only appears when
 * the origin is already down.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PROBE_PATHS } from "../../src/proxy.ts";

const caddyfile = readFileSync(
  fileURLToPath(new URL("../../Caddyfile", import.meta.url)),
  "utf8",
);

/**
 * Quote-aware block extractor: returns the text between the braces that follow
 * `opener`. The maintenance body is a quoted HTML document, and a naive scan
 * would count the `{…}` placeholder inside it as structure — the body is
 * brace-balanced today, but this is the kind of thing that silently mis-parses
 * the moment someone edits the page, and a mis-parse here turns a red test green.
 */
function blockBody(opener: string, src = caddyfile): string {
  const at = src.indexOf(opener);
  if (at === -1) throw new Error(`no block starting: ${opener}`);

  let i = src.indexOf("{", at);
  if (i === -1) throw new Error(`block has no body: ${opener}`);

  let depth = 0;
  const start = i + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
    } else if (ch === "#") {
      // A comment runs to end of line; its braces are not structure.
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    } else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
    i++;
  }
  throw new Error(`unbalanced block: ${opener}`);
}

/** Every `respond` in a chunk, with its matcher, body and status. */
function responds(chunk: string) {
  const out: { matcher: string; body: string; status: string }[] = [];
  const re = /respond\s+?(@[\w.-]+)?\s*"((?:[^"\\]|\\.)*)"\s*(\d{3})?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) {
    out.push({ matcher: m[1] ?? "", body: m[2] ?? "", status: m[3] ?? "" });
  }
  return out;
}

/** The path globs of a `path` / `not path` matcher definition. */
function pathMatcher(name: string): { negated: boolean; paths: string[] } {
  const body = blockBody(`@${name} {`);
  const m = body.match(/^[ \t]*(not[ \t]+)?path[ \t]+(\S.*?)[ \t]*$/m);
  if (!m) throw new Error(`@${name} is not a path matcher: ${body}`);
  return { negated: Boolean(m[1]), paths: m[2].split(/\s+/).filter(Boolean) };
}

const matcherPaths = (name: string): string[] => pathMatcher(name).paths;

const page = blockBody("(maintenance_page) {");
const errorHook = blockBody("handle_errors 502 503 {");
const responseHook = blockBody("handle_response @app_down {");
const catchAll = blockBody("\n\thandle {");

// The one document the edge writes, found through its matcher.
const pageRespond = responds(page).find((r) => r.matcher === "@page_surface");

describe("the edge answers an outage at the edge", () => {
  test("both outage shapes are wired, and both reach the page", () => {
    // handle_errors = no upstream response at all (stopped container, refused
    // connection). handle_response = the origin answered 502/503. Neither hook
    // substitutes for the other; see the docs note quoted in the file header.
    expect(errorHook, "handle_errors does not write the page").toContain(
      "import maintenance_page",
    );
    expect(responseHook, "handle_response does not write the page").toContain(
      "import maintenance_page",
    );
  });

  test("the response matcher lives inside the proxy that uses it", () => {
    // Caddy resolves `handle_response @name` against the response matchers
    // declared INSIDE that reverse_proxy block; a site-level definition fails to
    // adapt with "no named response matcher defined". Asserting the containment
    // is what keeps a future "tidy up, hoist the matchers together" from being a
    // config that will not load.
    expect(catchAll).toMatch(/@app_down\s*\{\s*status 502 503\s*\}/);
    expect(catchAll).toContain("handle_response @app_down {");
    // …and it is the app's proxy, i.e. the canary-aware upstream, not a copy
    // pinned to one colour: `docker compose` and scripts/deploy.mjs both flip
    // APP_UPSTREAM, and a maintenance rule bolted to a literal app:3000 would
    // answer for a container that is no longer serving traffic.
    expect(catchAll).toContain("reverse_proxy {$APP_UPSTREAM:app:3000}");
    expect(catchAll).toContain("health_uri /api/readyz");
  });

  test("the answer does not depend on the origin being up", () => {
    // The defect this block exists to remove. If the page were a file_server
    // under the app's own public/, or a rewrite back through the proxy, the
    // maintenance screen would need the thing that is down.
    for (const banned of ["reverse_proxy", "file_server", "public/"]) {
      expect(page, `the maintenance page depends on ${banned}`).not.toContain(banned);
    }
    expect(page).toContain("respond @page_surface");
  });
});

describe("the maintenance response is 503 + Retry-After + noindex", () => {
  test("every branch names an explicit status, and the page's is 503", () => {
    expect(pageRespond, "no @page_surface respond in the maintenance snippet").toBeTruthy();
    expect(pageRespond!.status).toBe("503");
    // A `respond` without a code answers 200 outside an error route, which is
    // both a false healthy and an indexable page — so no respond in either hook
    // is allowed to rely on a default.
    for (const r of [...responds(page), ...responds(errorHook), ...responds(responseHook)]) {
      expect(r.status, "a respond with no status code").not.toBe("");
      expect(r.status).not.toBe("200");
      expect(Number(r.status)).toBeGreaterThanOrEqual(400);
    }
  });

  test("Retry-After is set and agrees with the page's own auto-retry", () => {
    const retry = page.match(/header\s+@page_surface\s+Retry-After\s+"(\d+)"/);
    expect(retry, "no Retry-After on the maintenance response").toBeTruthy();
    // The two numbers are one promise told twice — the header for a client that
    // honours it, the meta refresh for the browser that does not. If they drift,
    // the browser cadence and the machine cadence disagree and somebody ends up
    // staring at a page nothing reloads.
    const refresh = pageRespond!.body.match(
      /<meta\s+http-equiv=['"]refresh['"]\s+content=['"](\d+)['"]/i,
    );
    expect(refresh, "no auto-refresh meta tag in the page").toBeTruthy();
    expect(refresh![1], "Retry-After and the meta refresh disagree").toBe(retry![1]);
  });

  test("it is unindexable in both places a crawler looks", () => {
    expect(page).toMatch(/header\s+@page_surface\s+X-Robots-Tag\s+"noindex/);
    expect(pageRespond!.body).toMatch(/<meta\s+name=['"]robots['"]\s+content=['"]noindex/i);
    // A cached 503 outlives the outage: the origin recovers and the page keeps
    // being served from a cache, which is how an incident report says it never
    // ended.
    expect(page).toMatch(/header\s+@page_surface\s+Cache-Control\s+"no-store/);
    // The page is an error document, not a frameable one. secure_defaults already
    // sets X-Frame-Options site-wide; asserted here so the maintenance route is
    // known to inherit it rather than being a separate surface.
    expect(caddyfile).toMatch(/X-Frame-Options\s+"DENY"/);
  });

  test("it is self-contained: no script, no subresource, no external font", () => {
    const body = pageRespond!.body.toLowerCase();
    expect(body).not.toContain("<script");
    expect(body).not.toContain("@import");
    expect(body).not.toMatch(/<link\b/);
    expect(body).not.toMatch(/\b(src|href)\s*=\s*['"]?(https?:)?\/\//);
    // Nothing outside Caddy may have to be up for this page to render, including
    // a CDN that is itself down during the incident.
    expect(body).not.toMatch(/https?:\/\//);
    // Animated, but with SVG SMIL rather than CSS: see the brace rule below.
    expect(body).toContain("<animate");
  });

  test("the body has no braces except the placeholders this edge actually fills", () => {
    // `respond` expands `{placeholder}` in its body before writing. A `<style>`
    // block would therefore run every CSS declaration through that scanner, so
    // the document is written with inline `style=` attributes and the only
    // braces allowed are the ones that are meant to be substituted.
    const WIRED = new Set(["time.now.http"]);
    const tokens = [...pageRespond!.body.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
    expect(tokens.length, "the page has no wired placeholder").toBeGreaterThan(0);
    for (const t of tokens) {
      expect(WIRED.has(t), `{${t}} is not a placeholder the edge fills`).toBe(true);
    }
    expect(pageRespond!.body).not.toContain("<style");
  });
});

describe("outage-only: the rule keys on 502/503 and nothing else", () => {
  test("the upstream matcher is exactly 502 and 503", () => {
    const m = blockBody("@app_down {").match(/status\s+([\d\s]+)\s*$/m);
    expect(m, "@app_down has no status list").toBeTruthy();
    const codes = m![1].trim().split(/\s+/);
    expect(codes).toEqual(["502", "503"]);
    // 5xx would sweep in the application's own 500 — its error boundary, digest
    // and Sentry event are the artifact an engineer needs, and a maintenance page
    // in front of them hides a defect behind a word that implies intent.
    expect(codes).not.toContain("500");
    expect(codes.join(" ")).not.toContain("xx");
  });

  test("the error hook is gated on the same codes", () => {
    // handle_errors takes status codes as its arguments, so an unrelated handler
    // error cannot be dressed up as planned downtime.
    expect(caddyfile).toMatch(/handle_errors 502 503 \{/);
    expect(caddyfile).not.toMatch(/handle_errors\s*(?:5xx|\{|[45]xx)/);
  });

  test("the bank API keeps the application's own answers", () => {
    // /v1/* is machine-consumed (docs/INTEGRATION-CONTRACT.md): a bank reads a
    // status code and a signed JSON body. Its proxy gets no handle_response, so
    // its 4xx and 5xx pass through exactly as the app wrote them.
    const v1 = blockBody("handle /v1/* {");
    expect(v1).not.toContain("handle_response");
    expect(v1).not.toContain("maintenance_page");
  });
});

describe("the surfaces a program reads are not answered with the page", () => {
  test("the two matcher lists are exact complements", () => {
    const machine = pathMatcher("machine_surface");
    const human = pathMatcher("page_surface");
    expect(machine.negated, "@machine_surface must be the positive path list").toBe(false);
    expect(human.negated, "@page_surface must be the negated path list").toBe(true);
    expect(machine.paths.length).toBeGreaterThan(0);
    // There is no `not @machine_surface` to compose in a Caddyfile matcher set,
    // so the same list appears twice. Duplicated lists drift; this is the check
    // that makes the drift fail loudly instead of showing a monitor a page.
    expect(human.paths.slice().sort()).toEqual(machine.paths.slice().sort());
  });

  test("every probe path the edge rate-limits is excluded from the page", () => {
    // The cross-file coupling, same shape as probe-budget.test.ts: PROBE_PATHS is
    // what src/proxy.ts treats as infrastructure, and this file is what decides
    // whether the edge answers those paths with a maintenance page.
    for (const re of PROBE_PATHS) {
      // [/^\/api\/health$/, …] -> "/api/health": strip the anchors and unescape
      // the slashes, so the comparison is against the path a request carries.
      const path = re.source
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replaceAll("\\/", "/");
      expect(
        matcherPaths("machine_surface").includes(path),
        `${path} is a probe path but the maintenance rule can swallow it`,
      ).toBe(true);
    }
  });

  test("Caddy's own health_uri is excluded too", () => {
    // /api/readyz answering 503 during a graceful drain (ADR-008) must stay a
    // single-meaning signal. If the drain answer were rewritten into a page, the
    // status would still be 503 — and the meaning would be gone.
    const uris = [...caddyfile.matchAll(/^\s*health_uri\s+(\S+)\s*$/gm)]
      .map((m) => m[1])
      .filter((u): u is string => Boolean(u));
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) {
      expect(
        matcherPaths("machine_surface").includes(uri),
        `health_uri ${uri} can be answered with the maintenance page`,
      ).toBe(true);
    }
  });

  test("the worker planes are excluded", () => {
    // A realtime or media-stream failure is a CALL-plane failure, and the page
    // below promises calls are unaffected. Answering one with the other is a lie.
    const machine = matcherPaths("machine_surface");
    expect(machine.some((p) => p.startsWith("/realtime"))).toBe(true);
    expect(machine.some((p) => p.startsWith("/v1"))).toBe(true);
  });

  test("the edge's own /healthz probe cannot be swallowed", () => {
    // docker-compose.yml's caddy healthcheck greps for
    // `HTTP/1.[01] (200|301|302|307|308)` on this exact path. A rule that ever
    // answered it with a 503 would mark the caddy container unhealthy and stall
    // any `docker compose up --wait`, i.e. the maintenance rule would turn itself
    // into a deployment failure.
    expect(caddyfile).toMatch(/handle \/healthz \{[\s\S]*?respond "ok" 200/);
    expect(matcherPaths("machine_surface")).toContain("/healthz");
    const compose = readFileSync(
      fileURLToPath(new URL("../../docker-compose.yml", import.meta.url)),
      "utf8",
    );
    expect(compose).toMatch(/wget -S --spider http:\/\/127\.0\.0\.1\/healthz/);
  });
});

describe("the rule sits beside the routing without shadowing it", () => {
  test("the page is reachable only through the two outage hooks", () => {
    const imports = [...caddyfile.matchAll(/import maintenance_page/g)].length;
    // One per hook. A third `import` at the site level would answer EVERY request
    // with a maintenance page — and `caddy validate` would pass, because the
    // config would be perfectly legal and permanently wrong.
    expect(imports).toBe(2);
    expect(errorHook).toContain("import maintenance_page");
    expect(responseHook).toContain("import maintenance_page");
    expect(page).not.toContain("import maintenance_page");
  });

  test("the existing route order is untouched by the new directives", () => {
    // tests/unit/caddy-gateway.test.ts owns these orderings; re-checked here
    // because this change is the one that adds directives next to them.
    expect(caddyfile.indexOf("handle /realtime/media-stream")).toBeLessThan(
      caddyfile.indexOf("handle /realtime/*"),
    );
    expect(caddyfile.indexOf("handle /v1/*")).toBeLessThan(caddyfile.indexOf("handle {"));
    // Matcher definitions and handle_errors are collected out of the route list
    // (matchers are matcher sets; handle_errors becomes the server's error
    // chain), so none of them can capture a request the handlers below own.
    expect(caddyfile).not.toMatch(/^\s*route\s*\{/m);
  });
});

describe("the page says what is down, and what is not", () => {
  test("it states the maintenance and the exception together", () => {
    const body = pageRespond!.body;
    expect(body.toLowerCase()).toContain("under maintenance");
    // Without this sentence the page tells a bank's analyst that the platform is
    // down while their fraud calls are still being answered by the containers
    // that serve them.
    expect(body).toContain("Live fraud calls and bank integrations are unaffected");
    // …and it says why the edge can know that: separate services, not a
    // whole-product claim.
    expect(body.toLowerCase()).toContain("separate services");
  });

  test("it recovers without a click, and identifies itself as the edge", () => {
    expect(pageRespond!.body).toMatch(/<meta\s+http-equiv=['"]refresh['"]/i);
    expect(pageRespond!.body.toLowerCase()).toContain("edge");
    expect(pageRespond!.body).toContain("503");
  });
});
