import { describe, expect, test } from "bun:test";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createPiEnvironment } from "../src/harnesses/pi/environment.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import { randomStartupTip, STARTUP_TIPS } from "../src/product/tips.ts";

describe("startup tips", () => {
  test("keeps tips unique, printable, and within two lines at the standard header width", () => {
    expect(STARTUP_TIPS.length).toBeGreaterThan(1);
    expect(new Set(STARTUP_TIPS).size).toBe(STARTUP_TIPS.length);
    for (const tip of STARTUP_TIPS) {
      expect(tip.trim()).not.toBe("");
      expect(tip).not.toMatch(/\p{Cc}/u);
      expect(wrapTextWithAnsi(tip, 82).length).toBeLessThanOrEqual(2);
    }
    expect(STARTUP_TIPS.some((tip) => tip.includes("/yolo"))).toBe(true);
  });

  test("can randomly select every tip, including the first and last", () => {
    for (const [index, tip] of STARTUP_TIPS.entries()) {
      expect(randomStartupTip(() => index / STARTUP_TIPS.length)).toBe(tip);
    }
    expect(randomStartupTip(() => 1 - Number.EPSILON)).toBe(STARTUP_TIPS.at(-1) ?? "");
    expect(STARTUP_TIPS).toContain(randomStartupTip());
  });

  test("passes one catalog tip to Pi instead of inheriting an old tip", () => {
    const inherited = { PI_AXON_STARTUP_TIP: "stale inherited tip" };
    const environment = createPiEnvironment(
      inherited,
      resolveAxonPaths({ AXON_HOME: "/managed/axon" }),
    );
    expect(STARTUP_TIPS).toContain(environment["PI_AXON_STARTUP_TIP"] ?? "");
    expect(inherited.PI_AXON_STARTUP_TIP).toBe("stale inherited tip");
  });
});
