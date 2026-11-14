// The accessible-controls requirement over the dashboard's markup and styles
// (web/index.html, web/style.css): roles and labels assistive technology
// reads, 44 px targets, and no animation under reduced motion.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const WEB = new URL("../web/", import.meta.url);
const html = await readFile(new URL("index.html", WEB), "utf8");
const css = await readFile(new URL("style.css", WEB), "utf8");

/** The opening tag of the element with `data-field="name"`. */
function tagOf(name: string): string {
  const tag = html.match(new RegExp(`<[a-z]+\\b[^>]*data-field="${name}"[^>]*>`))?.[0];
  assert.ok(tag !== undefined, `[data-field="${name}"] exists`);
  return tag;
}

/** The declarations of the top-level rule for exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(new RegExp(`^${escaped} \\{\\n([^}]*)\\}`, "m"))?.[1];
  assert.ok(body !== undefined, `${selector} has a rule`);
  return body;
}

describe("accessible controls", () => {
  it("the ticks are a progress bar labelled Print progress, with its value", () => {
    const ticks = tagOf("ticks");
    assert.match(ticks, /role="progressbar"/);
    assert.match(ticks, /aria-label="Print progress"/);
    assert.match(ticks, /aria-valuemin="0"/);
    assert.match(ticks, /aria-valuemax="100"/);
    assert.match(ticks, /aria-valuenow="\d+"/);
  });

  it("the stop thumb is a slider with its value", () => {
    const thumb = tagOf("slideThumb");
    assert.match(thumb, /role="slider"/);
    assert.match(thumb, /aria-label="Slide to stop print"/);
    assert.match(thumb, /aria-valuemin="0" aria-valuemax="100" aria-valuenow="\d+"/);
  });

  it("the message slot, the offline banner, and the pending stop are status regions", () => {
    for (const name of ["message", "banner", "slidePending"]) assert.match(tagOf(name), /role="status"/, name);
    assert.match(tagOf("messageDismiss"), /aria-label="Dismiss"/);
  });

  it("every interactive target is at least 44 px tall", () => {
    const targets = [...html.matchAll(/<(?:button|input)\b[^>]*class="([\w-]+)/g)].map((m) => m[1]!);
    assert.ok(targets.length >= 8, "found the page's buttons and inputs");
    for (const selector of new Set(targets)) {
      const body = rule(`.${selector}`);
      const heights = [...body.matchAll(/^\s*(?:min-)?height:\s*(\d+)px;/gm)].map((m) => Number(m[1]));
      assert.ok(heights.some((px) => px >= 44), `.${selector} is at least 44 px tall (${heights.join(", ") || "no height"})`);
    }
  });

  it("nothing animates under reduced motion", () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(block !== undefined, "a reduced-motion block");
    assert.match(block, /\*,\s*\*::before,\s*\*::after \{/);
    assert.match(block, /animation: none !important;/);
    assert.match(block, /transition: none !important;/);
  });
});
