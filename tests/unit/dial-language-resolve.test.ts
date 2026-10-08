import { describe, expect, it } from "bun:test";

import { resolveDeliveryLang } from "@/worker/dial";

/**
 * The language on the wire is a BCP-47 tag from the bank's system; the voice
 * tables are keyed by base language. A tag the tables do not carry must never
 * silently become an English call when an Arabic one was asked for.
 */
describe("resolveDeliveryLang", () => {
  it("passes an exact base language straight through", () => {
    for (const lang of ["en", "ar", "hi", "ur", "fr", "sw"]) {
      expect(resolveDeliveryLang(lang)).toBe(lang);
    }
  });

  it("honours the dialect subtag instead of dropping to English", () => {
    expect(resolveDeliveryLang("ar-AE")).toBe("ar");
    expect(resolveDeliveryLang("ar-SA")).toBe("ar");
    expect(resolveDeliveryLang("ar-EG")).toBe("ar");
    expect(resolveDeliveryLang("ur-PK")).toBe("ur");
    expect(resolveDeliveryLang("sw-KE")).toBe("sw");
  });

  it("normalises case and surrounding space", () => {
    expect(resolveDeliveryLang(" EN ")).toBe("en");
    expect(resolveDeliveryLang("AR-MA")).toBe("ar");
    expect(resolveDeliveryLang("fr_FR")).toBe("fr");
  });

  it("falls back to English when there is nothing to resolve", () => {
    expect(resolveDeliveryLang(undefined)).toBe("en");
    expect(resolveDeliveryLang("")).toBe("en");
    expect(resolveDeliveryLang("   ")).toBe("en");
    expect(resolveDeliveryLang(null)).toBe("en");
  });

  it("falls back to English for a language the platform does not speak", () => {
    expect(resolveDeliveryLang("es-MX")).toBe("en");
    expect(resolveDeliveryLang("xx")).toBe("en");
    // A tag that is not a language at all must not reach the provider as one.
    expect(resolveDeliveryLang("'); drop table")).toBe("en");
  });

  it("never returns something outside the voice table keys", () => {
    const spoken = ["en", "ar", "hi", "ur", "fr", "sw"];
    for (const probe of ["pt-BR", "ja", "zh-CN", "ar", "", "  AR  ", "ru-RU"]) {
      expect(spoken).toContain(resolveDeliveryLang(probe));
    }
  });
});
