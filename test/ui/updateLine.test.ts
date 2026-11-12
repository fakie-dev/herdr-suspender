// The update line at the top of Sessions and the switch at its bottom: what
// they say in each state, and that they fit any width at any zoom (G32).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modPx, type Scale, toMod, windowPx } from "../../src/core/scale.ts";
import { defaultUpdateState, type Outcome, type UpdateState } from "../../src/core/updateState.ts";
import { t } from "../../src/i18n/index.ts";
import { uiMeasure } from "../../src/ui/textWidth.ts";
import {
  ACTION_LABEL,
  BUTTON_PAD_X,
  BUTTON_TEXT,
  FOOTER_PAD_X,
  fitFooter,
  fitUpdateLine,
  footerToggleWidth,
  LINE_GAP,
  LINE_LEAD,
  LINE_PAD_X,
  LINE_TEXT_LEAST,
  lineDrawnWidth,
  updateLine,
} from "../../src/ui/updateLine.ts";

const state = (over: Partial<UpdateState> = {}): UpdateState => ({ ...defaultUpdateState(), ...over });
const outcome = (over: Partial<Outcome>): Outcome => ({
  kind: "updated",
  from: "0.1.2",
  to: "0.1.3",
  reason: null,
  count: null,
  at: 0,
  keys: [],
  ...over,
});

describe("the update line", () => {
  it("offers a newer release with Update and What's new", () => {
    const line = updateLine(state({ latest: "0.1.3" }), "0.1.2", "0.1.3", null);
    assert.equal(line?.text, "Suspender 0.1.3 is out");
    assert.deepEqual(line?.actions, ["whatsNew", "update"]);
  });

  it("is not there when nothing is newer, or the checks are off", () => {
    assert.equal(updateLine(state(), "0.1.2", null, null), null);
    assert.equal(updateLine(state({ latest: "0.1.3", checks: false }), "0.1.2", null, null), null);
  });

  it("spins while an update or a rollback runs, with nothing to press", () => {
    const job = { kind: "update" as const, from: "0.1.2", to: "0.1.3", at: 0, keys: [] };
    const line = updateLine(state({ job }), "0.1.2", "0.1.3", job);
    assert.equal(line?.text, "Updating to 0.1.3…");
    assert.equal(line?.spinning, true);
    assert.deepEqual(line?.actions, []);
    const back = { ...job, kind: "rollback" as const, to: "0.1.2", from: "0.1.3" };
    assert.equal(updateLine(state({ job: back }), "0.1.3", null, back)?.text, "Rolling back to 0.1.2…");
  });

  it("after an update: what's new, roll back, dismiss", () => {
    const line = updateLine(state({ outcome: outcome({}) }), "0.1.3", null, null);
    assert.equal(line?.text, "Updated to 0.1.3");
    assert.deepEqual(line?.actions, ["whatsNew", "rollBack", "dismiss"]);
  });

  it("after a refusal: why, how to update by hand, and the release page", () => {
    const o = outcome({ kind: "refused", reason: "edited", count: 2 });
    const line = updateLine(state({ outcome: o, latest: "0.1.3" }), "0.1.2", "0.1.3", null);
    assert.equal(line?.text, "Not updated: files were changed");
    assert.match(line?.detail ?? "", /2 file\(s\) in mods\/suspender.*by hand/);
    assert.deepEqual(line?.actions, ["page", "dismiss"]);
  });

  it("forgets an outcome another version wrote (it is not about this build)", () => {
    const line = updateLine(state({ outcome: outcome({ to: "0.1.4" }) }), "0.1.3", null, null);
    assert.equal(line, null);
  });
});

const ZOOMS = [0.5, 0.8, 1, 1.25, 1.5, 2, 3];

describe("the update line at any width", () => {
  const lines = [
    updateLine(state({ latest: "0.1.3" }), "0.1.2", "0.1.3", null),
    updateLine(state({ outcome: outcome({}) }), "0.1.3", null, null),
    updateLine(state({ outcome: outcome({ kind: "refused", reason: "renamed" }) }), "0.1.2", null, null),
  ];

  it("keeps its buttons inside the panel from 140 px, folding labels to icons", () => {
    for (const line of lines) {
      assert.ok(line !== null);
      for (const zoom of ZOOMS) {
        const scale: Scale = { zoom };
        for (let px = 140; px <= 1400; px += 3) {
          const width = windowPx(px * zoom);
          const mode = fitUpdateLine(line, width, scale, uiMeasure);
          const drawn = lineDrawnWidth(line, mode, uiMeasure);
          assert.ok(drawn <= toMod(scale, width), `${line.text} at ${px} px, zoom ${zoom}: ${drawn} drawn (${mode})`);
        }
      }
    }
  });

  it("folds the labels before they leave the text less than its least room", () => {
    const line = lines[0];
    assert.ok(line !== null && line !== undefined);
    for (let px = 140; px <= 600; px++) {
      if (fitUpdateLine(line, windowPx(px), { zoom: 1 }, uiMeasure) === "label") {
        const buttons: number = line.actions.reduce(
          (sum: number, a) => sum + LINE_GAP + 2 * BUTTON_PAD_X + uiMeasure(t(ACTION_LABEL[a]), BUTTON_TEXT),
          0,
        );
        const text: number = px - 2 * LINE_PAD_X - LINE_LEAD - LINE_GAP - buttons;
        assert.ok(text >= LINE_TEXT_LEAST, `${px} px: ${text} px left for the text`);
      }
    }
  });

  it("keeps the labels while there is room for them", () => {
    const line = lines[0];
    assert.ok(line !== null && line !== undefined);
    assert.equal(fitUpdateLine(line, windowPx(320), { zoom: 1 }, uiMeasure), "label");
    assert.equal(fitUpdateLine(line, windowPx(640), { zoom: 2 }, uiMeasure), "label");
    assert.equal(fitUpdateLine(line, windowPx(150), { zoom: 1 }, uiMeasure), "icon");
  });
});

describe("the switch at the bottom at any width", () => {
  it("stays inside the panel from 100 px, shortening its label before it goes", () => {
    for (const zoom of ZOOMS) {
      for (let px = 100; px <= 1400; px += 3) {
        const width = windowPx(px * zoom);
        const mode = fitFooter(width, { zoom }, uiMeasure);
        const drawn = 2 * FOOTER_PAD_X + footerToggleWidth(mode, uiMeasure);
        assert.ok(drawn <= toMod({ zoom }, width), `${px} px, zoom ${zoom}: ${drawn} drawn (${mode})`);
      }
    }
  });

  it("says it in full on a panel of the usual width", () => {
    assert.equal(fitFooter(windowPx(320), { zoom: 1 }, uiMeasure), "full");
    assert.equal(fitFooter(windowPx(110), { zoom: 1 }, uiMeasure), "icon");
    assert.ok(modPx(LINE_PAD_X) > 0);
  });
});
