import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findDuplicates } from "./check-dependency-duplicates.mjs";

describe("findDuplicates", () => {
  it("returns nothing when each watched package has a single version", () => {
    const tree = {
      dependencies: {
        react: { version: "19.2.8" },
        web: { version: "0.0.0", dependencies: { react: { version: "19.2.8" } } },
      },
    };
    assert.deepEqual(findDuplicates(tree, ["react"]), {});
  });

  it("detects the same package at two majors in different workspaces (the Vite 7 vs 8 shape)", () => {
    const tree = {
      dependencies: {
        vite: { version: "8.2.1" },
        frontend: { version: "0.1.0", dependencies: { vite: { version: "7.3.6" } } },
      },
    };
    assert.deepEqual(findDuplicates(tree, ["vite"]), { vite: ["7.3.6", "8.2.1"] });
  });

  it("finds duplicates nested several levels deep", () => {
    const tree = {
      dependencies: {
        a: { version: "1.0.0", dependencies: { b: { version: "1.0.0", dependencies: { typescript: { version: "6.0.2" } } } } },
        typescript: { version: "5.9.3" },
      },
    };
    assert.deepEqual(findDuplicates(tree, ["typescript"]), { typescript: ["5.9.3", "6.0.2"] });
  });

  it("ignores unwatched packages and nodes without a version", () => {
    const tree = {
      dependencies: {
        lodash: { version: "4.0.0" },
        other: { dependencies: { lodash: { version: "3.0.0" } } },
        react: { missing: true },
      },
    };
    assert.deepEqual(findDuplicates(tree, ["react"]), {});
  });

  it("tolerates an empty or malformed tree", () => {
    assert.deepEqual(findDuplicates({}, ["react"]), {});
    assert.deepEqual(findDuplicates(undefined, ["react"]), {});
    assert.deepEqual(findDuplicates({ dependencies: null }, ["react"]), {});
  });
});
