import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "../src/i18n/en.ts";
import { hasMessage, t } from "../src/i18n/index.ts";

describe("t", () => {
  it("returns the English text of a key", () => {
    assert.equal(t("strip.resume"), "Resume");
    assert.equal(t("panel.empty"), "No agent sessions yet — start Claude Code or Codex in any tab");
  });

  it("fills {placeholders} from params", () => {
    assert.equal(t("pill.sleep", { agent: "Codex" }), "Sleep · Codex");
  });

  it("makes a missing key visible instead of printing nothing", () => {
    // @ts-expect-error: the point is a key that does not exist.
    assert.equal(t("strip.no-such-key"), "⟦strip.no-such-key⟧");
    assert.equal(hasMessage("strip.no-such-key"), false);
    assert.equal(hasMessage("strip.resume"), true);
  });

  it("leaves a placeholder without a param visible", () => {
    assert.equal(t("pill.sleep"), "Sleep · {agent}");
    assert.equal(t("pill.sleep", { other: 1 }), "Sleep · {agent}");
  });

  it("names the Sessions button without a count", () => {
    assert.equal(t("toggle.label"), "Sessions");
    assert.equal(t("toggle.label", { count: 3 }), "Sessions");
  });

  it("keeps every text in one flat table of strings", () => {
    for (const [key, text] of Object.entries(en)) {
      assert.equal(typeof text, "string", key);
      assert.ok(text.length > 0, key);
    }
  });
});
