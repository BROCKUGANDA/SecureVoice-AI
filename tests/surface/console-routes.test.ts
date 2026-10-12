/**
 * The console's URLs, and the guarantee that none of them can be indexed.
 *
 * `/console` used not to exist: the whole operator experience was one page plus a
 * client-side `view` string, which is why the back button did nothing and why no
 * screen could be linked. It now has real routes — which means a defence that used
 * to be structural ("there is no URL to point a crawler at") became a set of
 * rules that have to agree.
 *
 * Four layers, asserted here:
 *
 *   1. the route metadata (`robots: { index: false }`),
 *   2. `NO_INDEX` in `src/app/robots.ts`,
 *   3. the `X-Robots-Tag` `src/proxy.ts` puts on every unlisted path,
 *   4. `MUST_NOT_LIST` in `src/app/sitemap.ts`.
 *
 * The mapping itself is tested for totality in both directions, because a view
 * that syncs to a path no route serves is a 404 on refresh, and a path that maps
 * to no view leaves the address bar showing a screen the user already left.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PATH_FOR_VIEW,
  SHELL_PATHS,
  isShellPath,
  pathForView,
  viewForPath,
} from "@/lib/console-routes";
import { VIEW_ACCESS, type View } from "@/lib/store";
import { NO_INDEX } from "@/app/robots";
import { MUST_NOT_LIST } from "@/app/sitemap";
import { robotsTagFor } from "../../src/proxy.ts";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const SHELL_VIEWS = Object.keys(PATH_FOR_VIEW) as View[];

describe("the view ↔ path mapping", () => {
  test("every mapped view resolves back to itself", () => {
    for (const view of SHELL_VIEWS) {
      const path = pathForView(view);
      expect(path, `${view} has no path`).not.toBeNull();
      expect(viewForPath(path!), `${view} → ${path} does not round-trip`).toBe(view);
    }
  });

  test("no two views share a path", () => {
    const paths = SHELL_VIEWS.map((v) => pathForView(v)!);
    expect(new Set(paths).size, paths.join(", ")).toBe(paths.length);
  });

  test("a trailing slash is the same screen", () => {
    expect(viewForPath("/console/settings/")).toBe("settings");
    // …but only off the root of a path: `/` is the landing view, not "nothing".
    expect(viewForPath("/")).toBe("home");
    expect(viewForPath("/console/nope")).toBeNull();
    expect(viewForPath("")).toBeNull();
    expect(viewForPath(null)).toBeNull();
  });

  test("the paths that must never be indexed are exactly the shell's", () => {
    // `/` is in the map so URL sync stays total, and it is the one page that most
    // wants to be indexed. If it ever leaks into SHELL_PATHS, the landing page
    // gets a noindex.
    expect(SHELL_PATHS).not.toContain("/");
    expect(SHELL_PATHS.every((p) => isShellPath(p))).toBe(true);
    expect(isShellPath("/console/anything-new")).toBe(true);
    expect(isShellPath("/pricing")).toBe(false);
    expect(isShellPath("/docs")).toBe(false);
  });
});

describe("the four indexability layers", () => {
  test("robots.txt disallows the console by prefix", () => {
    const disallowed = NO_INDEX.map((p) => String(p));
    expect(disallowed).toContain("/console");
    expect(disallowed).toContain("/sign-in");
    // Prefix form, not a list of screens: a sub-path added tomorrow is covered.
    expect(disallowed.some((p) => p === "/console/settings")).toBe(false);
  });

  test("the sitemap forbids every shell path by name", () => {
    const forbidden = new Set<string>(MUST_NOT_LIST);
    for (const path of SHELL_PATHS) {
      expect(forbidden.has(path), `${path} is not in MUST_NOT_LIST`).toBe(true);
    }
  });

  test("the middleware stamps noindex on every shell path", () => {
    for (const path of SHELL_PATHS) {
      expect(robotsTagFor(path), `${path} is indexable`).toBe("noindex, nofollow");
    }
    // And the landing page is still indexable, so this cannot be fixed by
    // blanket-denying everything.
    expect(robotsTagFor("/")).toBeNull();
    expect(robotsTagFor("/pricing")).toBeNull();
  });

  test("both route files declare noindex in their own metadata", () => {
    for (const file of ["src/app/console/[[...path]]/page.tsx", "src/app/sign-in/page.tsx"]) {
      const text = read(file);
      expect(text, `${file} has no robots metadata`).toContain("index: false");
      // And they render the shared shell rather than a copy of it.
      expect(text, `${file} duplicates the shell`).toContain('from "@/app/page"');
    }
  });
});

describe("the routes exist where the mapping says they should", () => {
  test("the console catch-all and the sign-in page are real files", () => {
    expect(read("src/app/console/[[...path]]/page.tsx")).toContain("export default function");
    expect(read("src/app/sign-in/page.tsx")).toContain("export default function");
  });

  test("the shell exports the component both routes import", () => {
    const text = read("src/app/page.tsx");
    expect(text).toContain("export function AppRoot");
    expect(text).toContain("export default AppRoot");
    // The back-button half: a popstate listener and a history write. Either one
    // missing and the URL stops tracking the screen again, quietly.
    expect(text).toContain('window.addEventListener("popstate"');
    expect(text).toContain("window.history[");
    expect(text).toContain('"replaceState"');
    expect(text).toContain('"pushState"');
  });

  test("no shell path is also a public indexable route", () => {
    // The inverse of the check above, stated as a collision: `/console/settings`
    // must not also be a directory someone adds under src/app with its own
    // metadata. The catch-all owns the whole prefix.
    for (const path of SHELL_PATHS) {
      if (path === "/sign-in") continue;
      const asDir = `src/app${path}/page.tsx`;
      expect(existsSync(fileURLToPath(new URL(`../../${asDir}`, import.meta.url))), asDir).toBe(
        false,
      );
    }
  });
});

describe("the access model is unchanged by the URLs", () => {
  test("every shell view still declares who may see it", () => {
    for (const view of SHELL_VIEWS) {
      // `home` and `auth` are public; everything under /console is not.
      const access = VIEW_ACCESS[view];
      expect(access, `${view} has no declared access`).toBeDefined();
      const path = pathForView(view)!;
      if (path.startsWith("/console")) expect(access, path).not.toBe("public");
    }
  });
});
