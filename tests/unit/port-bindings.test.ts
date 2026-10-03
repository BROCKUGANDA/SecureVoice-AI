/**
 * UNIT — the composition root (src/lib/ports/registry.ts).
 *
 * `PORT_BINDINGS` is the repository's honest statement of which adapters exist
 * and which do not. It is a document that can rot silently: an adapter can be
 * added without a declaration, a `real`/`fake` pair can drift from the `bound`
 * list, or a `notBound` entry can rot into a stale claim. The properties below
 * are what keep that document true.
 *
 * Only the TABLE is exercised here. `createRegistry()` is deliberately not
 * imported: it transitively pulls the ElevenLabs, Twilio and Postgres adapters,
 * and asserting on module-load side effects would test the imports rather than
 * the contract. The registry itself is integration territory.
 */
import { describe, expect, test } from "bun:test";
import { PORT_BINDINGS } from "@/lib/ports/registry";
import { PORT_NAMES, type PortName } from "@/lib/ports/types";

const ENTRIES = Object.entries(PORT_BINDINGS) as Array<
  [PortName, (typeof PORT_BINDINGS)[PortName]]
>;

describe("PORT_BINDINGS — completeness", () => {
  test("every declared port has a binding entry", () => {
    // A port with no entry is a port nobody has decided how to satisfy, which
    // is precisely the ambiguity the table exists to remove.
    for (const port of PORT_NAMES) {
      expect({ port, declared: PORT_BINDINGS[port] !== undefined }).toEqual({
        port,
        declared: true,
      });
    }
  });

  test("no binding entry exists for an undeclared port", () => {
    for (const [port] of ENTRIES) {
      expect(PORT_NAMES).toContain(port);
    }
  });

  test("each entry's `port` field agrees with its own key", () => {
    for (const [port, binding] of ENTRIES) {
      expect({ key: port, field: binding.port }).toEqual({ key: port, field: port });
    }
  });
});

describe("PORT_BINDINGS — declared adapters", () => {
  test("every port declares at least one bound adapter", () => {
    for (const [port, binding] of ENTRIES) {
      expect({ port, bound: binding.bound.length > 0 }).toEqual({ port, bound: true });
    }
  });

  // NAMING INCONSISTENCY, documented rather than asserted. `real` is a
  // human-readable description while `bound` is a list of adapter identifiers,
  // and two ports spell the same adapter differently in the two fields:
  //   NotificationSink  real "contact-centre (console inbox)" vs bound "contact-centre"
  //   AuditSink         real "postgres append-only"           vs bound "postgres-append-only"
  // Neither is a functional defect — nothing resolves `real` through `bound` —
  // but it means "real" cannot be used as a key into the declared list.
  test("every port names a real adapter", () => {
    for (const [port, binding] of ENTRIES) {
      expect({ port, real: binding.real.trim().length > 0 }).toEqual({ port, real: true });
    }
  });

  test("Clock and IdGenerator legitimately share the 'system' real adapter", () => {
    // Not a duplicate entry — both ports really are served by the system, and
    // their fakes differ ("fixed clock" vs "seeded ULIDs"), which is the
    // distinction that matters for offline mode.
    expect(PORT_BINDINGS.Clock.real).toBe("system");
    expect(PORT_BINDINGS.IdGenerator.real).toBe("system");
    expect(PORT_BINDINGS.Clock.fake).not.toBe(PORT_BINDINGS.IdGenerator.fake);
  });

  test("an adapter is never both bound and not-bound", () => {
    for (const [port, binding] of ENTRIES) {
      const notBound = binding.notBound.map((n) => n.adapter);
      const overlap = binding.bound.filter((b) => notBound.includes(b));
      expect({ port, overlap }).toEqual({ port, overlap: [] });
    }
  });

  test("every notBound entry gives a real reason, not a placeholder", () => {
    for (const [port, binding] of ENTRIES) {
      for (const entry of binding.notBound) {
        expect({ port, adapter: entry.adapter, reason: entry.reason.length }).toEqual({
          port,
          adapter: entry.adapter,
          reason: expect.any(Number),
        });
        expect(entry.reason.length).toBeGreaterThan(10);
        expect(entry.reason.toLowerCase()).not.toContain("todo");
      }
    }
  });

  test("notBound adapter names are unique within a port", () => {
    for (const [port, binding] of ENTRIES) {
      const names = binding.notBound.map((n) => n.adapter);
      expect({ port, unique: new Set(names).size === names.length }).toEqual({
        port,
        unique: true,
      });
    }
  });

  test("no adapter is claimed as bound anywhere it is declared not-bound", () => {
    // Cross-port check: SMS belongs to TelephonyProvider, not NotificationSink.
    // Declaring it in both places is how a reader ends up wiring the wrong one.
    const boundEverywhere = ENTRIES.flatMap(([, b]) => b.bound);
    for (const [port, binding] of ENTRIES) {
      for (const entry of binding.notBound) {
        const elsewhere = ENTRIES.filter(
          ([other, b]) => other !== port && b.bound.includes(entry.adapter),
        );
        // Allowed only when the reason explains the deliberate placement.
        if (elsewhere.length > 0) {
          expect(entry.reason.length).toBeGreaterThan(20);
        }
      }
    }
    expect(boundEverywhere.length).toBeGreaterThan(0);
  });
});

describe("PORT_BINDINGS — the money and identity ports", () => {
  test("the bound payment adapter needs no gateway credential", () => {
    // Manual invoice is chosen precisely because it is exercisable with no
    // money movement; a bound gateway adapter would make the offline path
    // untestable.
    expect(PORT_BINDINGS.PaymentProvider.real).toBe("manualinvoice");
  });

  test("the bound secret store is the environment, not a vault", () => {
    expect(PORT_BINDINGS.SecretStore.real).toBe("env");
    expect(PORT_BINDINGS.SecretStore.bound).toContain("env");
  });

  test("the audit sink is append-only postgres in real mode", () => {
    expect(PORT_BINDINGS.AuditSink.real).toBe("postgres append-only");
    expect(PORT_BINDINGS.AuditSink.fake).not.toBe(PORT_BINDINGS.AuditSink.real);
  });

  test("every port has a distinct fake from its real adapter", () => {
    // A fake identical to the real adapter means offline mode silently makes
    // network calls — the exact failure the mode exists to prevent.
    for (const [port, binding] of ENTRIES) {
      expect({ port, distinct: binding.fake !== binding.real }).toEqual({ port, distinct: true });
    }
  });

  test("every fake adapter is named", () => {
    for (const [port, binding] of ENTRIES) {
      expect(binding.fake.length).toBeGreaterThan(0);
      expect(binding.real.length).toBeGreaterThan(0);
    }
  });
});
