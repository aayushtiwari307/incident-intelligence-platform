import assert from "node:assert/strict";
import { normalizeRemoteTimestamp, sanitizeRemoteList, sanitizeRemoteText } from "./remote-text";

describe("remote text hygiene", () => {
  it("strips control, bidi-override and zero-width characters and collapses whitespace", () => {
    assert.equal(sanitizeRemoteText("a\u0000b\u0007c", 50), "a b c");
    assert.equal(sanitizeRemoteText("safe\u202etxt.exe", 50), "safe txt.exe");
    assert.equal(sanitizeRemoteText("ig\u200bnore  \n\t previous", 50), "ig nore previous");
    assert.equal(sanitizeRemoteText("  \u2028 x \u2029 ", 50), "x");
  });

  it("strips exactly the documented control, bidi and zero-width ranges and nothing else (every UTF-16 code unit)", () => {
    const stripped: Array<[number, number]> = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
    const isStripped = (cp: number) => stripped.some(([lo, hi]) => cp >= lo && cp <= hi);
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      const out = sanitizeRemoteText(`a${ch}b`, 10);
      // Stripped characters and ordinary whitespace both end up as one space; every other code unit must survive untouched.
      const expected = isStripped(cp) || /\s/.test(ch) ? "a b" : `a${ch}b`;
      assert.equal(out, expected, `U+${cp.toString(16).padStart(4, "0")}`);
    }
  });

  it("leaves markup as inert text for the escaped renderer (it does not try to sanitize HTML)", () => {
    assert.equal(sanitizeRemoteText("<img src=x onerror=alert(1)>", 100), "<img src=x onerror=alert(1)>");
  });

  it("truncates by code point and never splits a surrogate pair", () => {
    assert.equal(sanitizeRemoteText("abcdef", 3), "abc");
    const out = sanitizeRemoteText("\u{1f600}\u{1f600}\u{1f600}\u{1f600}", 3);
    assert.equal(Array.from(out).length, 3);
    assert.equal(out, "\u{1f600}\u{1f600}\u{1f600}");
    assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("returns an empty string for non-strings and nonsensical limits", () => {
    for (const v of [null, undefined, 5, {}, []]) assert.equal(sanitizeRemoteText(v, 10), "");
    assert.equal(sanitizeRemoteText("abc", 0), "");
    assert.equal(sanitizeRemoteText("abc", 1.5), "");
  });

  it("sanitizes lists of labels, de-duplicates, drops blanks and caps the count", () => {
    const labels = [{ name: "bug" }, "bug", { name: "  p1\u0000 " }, { name: "" }, null, 7, { name: "x".repeat(80) }, { name: "d" }, { name: "e" }];
    assert.deepEqual(sanitizeRemoteList(labels, 4, 50), ["bug", "p1", "x".repeat(50), "d"]);
    assert.deepEqual(sanitizeRemoteList("not a list", 5, 5), []);
    assert.deepEqual(sanitizeRemoteList(["a", "b"], 0, 5), []);
    assert.deepEqual(sanitizeRemoteList(["a", "b"], 2, 0), []);
  });
});


describe("remote timestamp validation", () => {
  it("normalizes valid RFC 3339 timestamps and rejects Date.parse calendar normalization", () => {
    assert.equal(normalizeRemoteTimestamp("2026-10-25T09:00:00+05:00"), "2026-10-25T04:00:00.000Z");
    assert.equal(normalizeRemoteTimestamp("2026-09-31T12:00:00Z"), null);
    assert.equal(normalizeRemoteTimestamp("2025-02-29T12:00:00Z"), null);
    assert.equal(normalizeRemoteTimestamp("2024-02-29T12:00:00Z"), "2024-02-29T12:00:00.000Z");
    assert.equal(normalizeRemoteTimestamp("2026-01-01T00:00:00-00:00"), null);
    assert.equal(normalizeRemoteTimestamp("2026-10-25T04:00:00"), null);
  });
});
