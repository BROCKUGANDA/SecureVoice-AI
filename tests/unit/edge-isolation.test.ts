/**
 * The edge must serve THIS project and nothing else.
 *
 * ── What broke, and why this file exists ───────────────────────────────────────
 *
 * One Caddy used to front two products on one box. It reached the other
 * product's containers BY SERVICE NAME, which only resolves from inside that
 * product's Docker network, so the shared edge was hand-attached to a network
 * this compose file does not own — and `docker compose up` rebuilds a
 * container from ITS compose definition, so every recreate dropped those
 * attachments.
 *
 * On 2026-10-21 a traffic flip recreated the edge, the attachment was
 * dropped, and the OTHER product answered 502 for every request while every
 * one of its own containers reported itself healthy. One project's deploy was
 * another project's outage.
 *
 * The first fix preserved the attachments across a recreate. That worked, and
 * it was the wrong shape: it kept a cross-project capability alive, made this
 * deploy script responsible for another product's reachability, and left the
 * blast radius exactly where it was.
 *
 * So the coupling is removed rather than accommodated, and these assertions
 * exist so it cannot come back quietly:
 *
 *   1. The tracked Caddyfile is the WHOLE edge configuration. No host-local
 *      directory is imported into it, so every name this edge answers for is
 *      a literal in a reviewed file — and the three availability zones cannot
 *      drift apart, because a host-local file guarantees they do.
 *   2. The edge's Docker network is this project's, declared, and only this
 *      project's.
 *   3. The front door's routing table and the Caddyfile's site list are the
 *      same set of names. A name in one and not the other is a name that
 *      black-holes on the public path, or a name nobody routes.
 *   4. The deploy script REPORTS a foreign attachment, and — once the edge
 *      has been cut over — REFUSES to recreate rather than preserving it.
 *
 * These parse the files as text on purpose. `caddy validate` proves the
 * syntax; it says nothing about what the file is allowed to serve.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const caddyfile = read("Caddyfile");
const composeFile = read("docker-compose.yml");
const deployScript = read("scripts/deploy.mjs");
const ci = read(".github/workflows/ci.yml");
const edgeConf = read("edge/nginx/edge.conf");
const sniMap = read("edge/nginx/edge.d/securevoice.sni.map");
const hostMap = read("edge/nginx/edge.d/securevoice.host.map");

const compose = YAML.parse(composeFile, { merge: true });

/**
 * The site addresses in a Caddyfile: every top-level block whose header is a
 * comma-separated list of addresses.
 *
 * A top-level site block is a line that is not indented, is not a comment,
 * ends with `{`, is not the lone `{` that opens the global options block, and
 * is not a snippet definition (`(name) {`). That is enough for a file whose
 * site list is a short literal list, and the alternative — a real Caddyfile
 * parser — is a dependency this repository does not need for one assertion.
 */
function siteAddresses(src: string): string[] {
  const found: string[] = [];
  for (const line of src.split("\n")) {
    if (line.trim() === "" || /^\s/.test(line)) continue;
    if (line.trimStart().startsWith("#")) continue;
    if (!line.trimEnd().endsWith("{")) continue;
    const header = line.trimEnd().slice(0, -1).trim();
    if (header === "") continue; // the global options block
    if (header.startsWith("(")) continue; // a snippet definition
    for (const part of header.split(",")) {
      const address = part.trim().replace(/^https?:\/\//, "");
      if (address) found.push(address);
    }
  }
  return [...new Set(found)];
}

/**
 * The configuration with its comments removed.
 *
 * The front door's file explains WHY it does not do several things, and
 * those explanations mention the directives it is asserting the absence of.
 * An assertion about behaviour has to look at behaviour.
 */
function withoutComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * The names a map file routes, as `name -> target` pairs.
 *
 * Comments and blank lines are dropped; a line is `name address:port;`.
 * The trailing semicolon is nginx's `map` syntax and it is REQUIRED — a
 * missing one makes `nginx -t` refuse the whole configuration, and the front
 * door is what every public name on the box depends on. The semicolon is
 * stripped here so the target can be compared as an address, and a separate
 * test asserts that it was there.
 */
function mapEntries(src: string): Array<{ name: string; target: string }> {
  return src
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(/\s+/);
      return { name, target: rest.join(" ").replace(/;$/, "") };
    });
}

const caddySites = siteAddresses(caddyfile);
const publicSites = caddySites.filter((s) => s !== "localhost");
const sniEntries = mapEntries(sniMap);
const hostEntries = mapEntries(hostMap);

describe("the tracked Caddyfile is the whole edge configuration", () => {
  test("it imports no host-local site directory", () => {
    // The wildcard import was the mechanism by which a SECOND product's site
    // block entered this edge: untracked, invisible to review, invisible to
    // `git diff`, and pulled in by a file that is committed and reviewed — so
    // nothing about the tracked Caddyfile said the effective configuration
    // was bigger than the file.
    expect(caddyfile).not.toMatch(/^\s*import\s+sites\.d/m);
    expect(composeFile).not.toMatch(/sites\.d/);
  });

  test("every name it answers for is a literal in the file", () => {
    // `localhost` is the CI and laptop block; everything else is a public
    // name, and a public name that is not in the front door's table is a name
    // that black-holes on the public path.
    expect(caddySites.length).toBeGreaterThan(0);
    expect(publicSites.length).toBeGreaterThan(0);
    for (const site of publicSites) {
      expect(sniEntries.map((e) => e.name)).toContain(site);
    }
  });

  test("it does not name another product", () => {
    // The other product's block used to live in this box's sites.d/ and was
    // served by this container. Its name must not appear in this project's
    // edge, in its front door table, or in its deploy script.
    for (const src of [caddyfile, composeFile, deployScript, edgeConf, sniMap, hostMap]) {
      expect(src).not.toContain("crucible");
      expect(src).not.toContain("svalley");
    }
  });
});

describe("the front door's table and the edge agree", () => {
  test("the TLS table routes exactly the public names", () => {
    expect(sniEntries.map((e) => e.name).sort()).toEqual([...publicSites].sort());
  });

  test("the plain-HTTP table routes exactly the public names", () => {
    // Plain HTTP carries no SNI, so the Host header is the key. A name in one
    // table and not the other black-holes: the ACME HTTP-01 challenge for
    // that name would go nowhere, and the certificate would never renew.
    expect(hostEntries.map((e) => e.name).sort()).toEqual([...publicSites].sort());
  });

  test("`localhost` is not routed publicly", () => {
    // It is a CI and laptop block. The front door has no business forwarding
    // a public connection to it.
    expect(sniEntries.map((e) => e.name)).not.toContain("localhost");
    expect(hostEntries.map((e) => e.name)).not.toContain("localhost");
  });

  test("every entry ends with the semicolon nginx's `map` requires", () => {
    // Found the hard way: `nginx -t` refused the whole configuration with
    // "unexpected end of file, expecting ; or }" because a map entry was
    // written without its terminator. Nothing else caught it — the maps are
    // not Caddyfile, and the edge's own `caddy validate` does not read them.
    // The front door is what every public name on the box depends on, so a
    // syntax error in a map is a total outage, and it is a total outage that
    // no test in this repository would have seen.
    for (const src of [sniMap, hostMap]) {
      const entries = src
        .split("\n")
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter(Boolean);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry, `a map entry is not terminated: ${entry}`).toMatch(/;$/);
      }
    }
  });

  test("every target is this edge's own loopback address", () => {
    // The front door runs in the host's network namespace and reaches the
    // edges over 127.0.0.1. A target on a routable address would mean the
    // traffic leaves the host — and the client IP the edge sees would no
    // longer be the client's.
    for (const entry of [...sniEntries, ...hostEntries]) {
      expect(entry.target).toMatch(/^127\.0\.0\.1:\d+$/);
    }
  });

  test("the TLS and HTTP tables point at different ports", () => {
    // 443 and 80. A copy-paste that pointed both at the same port would
    // send the ACME challenge to the TLS listener.
    const tlsPort = sniEntries[0]?.target.split(":")[1];
    const httpPort = hostEntries[0]?.target.split(":")[1];
    expect(tlsPort).toBeDefined();
    expect(httpPort).toBeDefined();
    expect(tlsPort).not.toBe(httpPort);
  });
});

describe("the front door is an L4 forwarder, and the TLS path stays that way", () => {
  test("it reads the SNI without decrypting anything", () => {
    const config = withoutComments(edgeConf);
    expect(config).toContain("ssl_preread on");
    expect(config).not.toContain("ssl_certificate");
    expect(config).not.toContain("proxy_protocol on");
  });

  test("an unknown name is refused, not routed", () => {
    // Fail-closed: the default is a closed port on loopback, so an
    // unrecognised SNI gets no service and no information about the host.
    const defaults = edgeConf.match(/default\s+([^;]+);/g) ?? [];
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) {
      expect(d).toMatch(/127\.0\.0\.1:9/);
    }
  });

  test("it shares no Docker network with a product", () => {
    // `network_mode: host` is the isolation: the router reaches each edge
    // over the host's loopback, so no product has a network path to another.
    const edgeCompose = read("edge/compose.yml");
    expect(edgeCompose).toContain("network_mode: host");
    expect(edgeCompose).not.toMatch(/^\s+networks:/m);
  });

  test("CI validates the front door's configuration", () => {
    // The front door is what every public hostname on the box is served
    // through, and `caddy validate` does not read it. Without this step a
    // syntax error in the front door's maps reaches production and takes
    // every public name down — and no other gate in this repository would
    // have seen it.
    expect(ci).toContain("scripts/edge-validate.mjs");
    expect(ci).toContain("Verify the shared front door's configuration");
  });

  test("the validator runs the image the front door actually runs", () => {
    // A validator that checks a different nginx build than the one serving
    // traffic is a validator that can be right about the wrong thing.
    const edgeCompose = read("edge/compose.yml");
    const image = edgeCompose.match(/image:\s*(\S+)/)?.[1];
    expect(image).toBeTruthy();
    expect(read("scripts/edge-validate.mjs")).toContain(`"${image}"`);
  });

  test("the plaintext path is a forwarder, and the TLS path is not an HTTP server", () => {
    // The TLS path must stay L4: no TLS termination, no request inspection,
    // no certificate. The plaintext path has to parse HTTP — a plaintext
    // connection carries no SNI, so a hostname cannot be read out of one
    // otherwise — and it forwards, nothing more.
    const config = withoutComments(edgeConf);
    expect(config).toMatch(/^\s*stream\s*\{/m);
    expect(config).toMatch(/^\s*http\s*\{/m);
    expect(config).toContain("ssl_preread on");
    expect(config).not.toContain("ssl_certificate");
    expect(config).not.toContain("proxy_protocol on");
    // The plaintext listener forwards to the edge; it does not answer.
    expect(config).toContain("proxy_pass http://$edge_http_backend;");
  });
});

describe("the edge's Docker network is this project's and only this project's", () => {
  test("the compose file declares exactly one network for it", () => {
    // Declared explicitly, so a `docker compose up` cannot attach the edge to
    // a network it does not own. The shared edge WAS hand-attached to
    // another product's network, and every recreate dropped the attachment.
    expect(compose.services.caddy.networks).toEqual(["default"]);
  });

  test("the shared compose file declares no top-level network at all", () => {
    // A top-level `networks:` block is where an `external:` network would be
    // declared — which is how a project reaches another project's network by
    // name. There is none, and there must not be one.
    expect(compose.networks).toBeUndefined();
  });

  test("the edge publishes only the edge's own ports", () => {
    // The app's port stays unpublished: the trust model in src/proxy.ts
    // depends on nothing but the edge being able to reach the origin.
    const published = compose.services.caddy.ports as string[];
    for (const mapping of published) {
      const [, containerPort] = mapping.split(":").slice(-2);
      expect(["80", "443"]).toContain(containerPort.replace("/udp", ""));
    }
    expect(compose.services.app.ports).toBeUndefined();
    // The one opt-in escape hatch that publishes :3000 is behind a profile
    // that is not started by default.
    expect(compose.services["app-direct"].profiles).toEqual(["direct"]);
  });
});

describe("the deploy script reports the coupling instead of accommodating it", () => {
  test("it can read the foreign networks, and owns them by name", () => {
    // The filter is by OWNERSHIP — anything that is not this project's own
    // network — so it covers a project that does not exist yet and never
    // learns another project's name.
    expect(deployScript).toContain("foreignCaddyNetworks()");
    expect(deployScript).toContain("`${projectName()}_default`");
    expect(deployScript).toContain("ours.has(name)");
  });

  test("there is still exactly ONE place that recreates caddy", () => {
    // The loss of a network attachment is silent and lands on a product that
    // has nothing to do with this one, so a second recreate path that
    // "forgot" would reproduce the 2026-10-21 outage from a different
    // command. The emergency revert is the worst place for that to hide.
    const rawRecreates = deployScript.match(/compose\(\["up", "-d", "--no-deps", "caddy"\]/g) ?? [];
    expect(rawRecreates).toHaveLength(1);
    expect(deployScript).toContain("recreateCaddy({ capture: true, env: { IMAGE: image } })");
    expect(deployScript).toContain("recreateCaddy({ allowFail: true })");
  });

  test("in the isolated arrangement it REFUSES rather than preserving", () => {
    // Preserving a foreign attachment in the target state would quietly
    // re-create the coupling this arrangement exists to end.
    const helperAt = deployScript.indexOf("function recreateCaddy(");
    expect(helperAt).toBeGreaterThan(-1);
    const helper = deployScript.slice(helperAt, deployScript.indexOf("\n}\n", helperAt));

    expect(helper).toContain('edgeMode() === "isolated"');
    expect(helper).toContain("refusing to recreate caddy");
    expect(helper.indexOf("refusing to recreate caddy")).toBeLessThan(
      helper.indexOf('compose(["up", "-d", "--no-deps", "caddy"]'),
    );
  });

  test("in the retired arrangement it preserves AND says so", () => {
    // Until the box is cut over, dropping the attachment is the outage. So it
    // is preserved — and the operator is told, every time, that the edge
    // should be split. A deprecated arrangement that still works beats a
    // deploy script that fails on a production box.
    const helperAt = deployScript.indexOf("function recreateCaddy(");
    const helper = deployScript.slice(helperAt, deployScript.indexOf("\n}\n", helperAt));

    expect(helper).toContain("reattachCaddyNetworks(foreign)");
    expect(helper).toContain("edge-isolate");
  });

  test("the cutover is a command, and it checks before it acts", () => {
    expect(deployScript).toContain("edge-isolate");
    expect(deployScript).toContain("edge-status");
    expect(deployScript).toContain("refusing to cut the edge over");
    // The preconditions are the whole safety of the command: the edge must
    // publish only loopback, the table must name the addresses it actually
    // publishes, and every public name must answer.
    expect(deployScript).toContain("publicBindings");
    expect(deployScript).toContain("publicNameAnswers");
  });
});
