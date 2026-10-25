import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProblems,
  createOptionalExtraneousCheck,
  findDuplicates,
  parseNpmLsResult,
  validateNpmTree,
} from "./check-dependency-duplicates.mjs";

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


describe("validateNpmTree", () => {
  it("fails closed when npm reports an unhealthy or missing dependency tree", () => {
    assert.throws(() => validateNpmTree({ dependencies: {}, problems: ["missing: jest"] }, 1), /healthy dependency tree/);
    assert.throws(() => validateNpmTree({ dependencies: {} }, 1), /healthy dependency tree/);
    assert.deepEqual(validateNpmTree({ dependencies: {} }, 0), { dependencies: {} });
  });
});

// The exact shape npm 10 produced after a clean `npm ci` of this lockfile on Windows and Linux: exit code 0, but two
// `extraneous` problems for an unconstrained optional package whose platform-gated parents are not installed.
const ROOT = "/work/project";
const SHARP = `extraneous: @img/sharp-wasm32@0.35.5 ${ROOT}/node_modules/@img/sharp-wasm32`;
const EMNAPI = `extraneous: @emnapi/runtime@1.11.3 ${ROOT}/node_modules/@img/sharp-wasm32/node_modules/@emnapi/runtime`;
const LOCK = {
  "node_modules/@img/sharp-wasm32": { version: "0.35.5", optional: true },
  "node_modules/@img/sharp-wasm32/node_modules/@emnapi/runtime": { version: "1.11.3", optional: true },
  "node_modules/react": { version: "19.2.8" },
};
const ctx = { lockPackages: LOCK, root: ROOT };
const treeWith = (problems) => JSON.stringify({ name: "incident-platform", dependencies: { react: { version: "19.2.8" } }, problems });

describe("createOptionalExtraneousCheck", () => {
  const benign = createOptionalExtraneousCheck(LOCK, ROOT);

  it("accepts only extraneous packages that the lockfile declares optional at that exact path and version", () => {
    assert.equal(benign(SHARP), true);
    assert.equal(benign(EMNAPI), true);
  });

  it("rejects a reported package name that does not match the package installed at the optional lockfile path", () => {
    assert.equal(
      benign(`extraneous: attacker-pkg@0.35.5 ${ROOT}/node_modules/@img/sharp-wasm32`),
      false,
      "a different package name cannot borrow another package's optional lockfile entry",
    );
    assert.equal(
      benign(`extraneous: attacker-pkg@1.11.3 ${ROOT}/node_modules/@img/sharp-wasm32/node_modules/@emnapi/runtime`),
      false,
      "the installed path's package identity must also match for nested optional packages",
    );
  });

  it("rejects everything else", () => {
    assert.equal(benign(`extraneous: left-pad@1.0.0 ${ROOT}/node_modules/left-pad`), false, "not in the lockfile");
    assert.equal(benign(`extraneous: react@19.2.8 ${ROOT}/node_modules/react`), false, "in the lockfile but not optional");
    assert.equal(benign(`extraneous: @img/sharp-wasm32@0.35.4 ${ROOT}/node_modules/@img/sharp-wasm32`), false, "version differs from the lockfile");
    assert.equal(benign(`extraneous: @img/sharp-wasm32@0.35.5 /elsewhere/node_modules/@img/sharp-wasm32`), false, "outside the project");
    assert.equal(benign(`extraneous: @img/sharp-wasm32@0.35.5 ${ROOT}`), false, "the project root itself");
    assert.equal(benign(`missing: @img/sharp-wasm32@0.35.5, required by sharp@0.35.5`), false, "not an extraneous problem");
    assert.equal(benign(`invalid: @img/sharp-wasm32@0.35.5 ${ROOT}/node_modules/@img/sharp-wasm32`), false, "not an extraneous problem");
    assert.equal(benign(undefined), false);
    assert.equal(createOptionalExtraneousCheck(null, ROOT)(SHARP), false, "no lockfile evidence means nothing is provably benign");
  });
});

describe("classifyProblems", () => {
  it("treats a malformed problems value as blocking", () => {
    assert.deepEqual(classifyProblems({ problems: "oops" }).blocking.length, 1);
    assert.deepEqual(classifyProblems({}), { blocking: [], ignored: [] });
  });
});

describe("parseNpmLsResult (fail-closed, with the real cause in each message)", () => {
  it("passes the tree through when npm ls is healthy", () => {
    const { tree, ignored } = parseNpmLsResult({ status: 0, stdout: treeWith([]) }, ctx);
    assert.equal(tree.name, "incident-platform");
    assert.deepEqual(ignored, []);
  });

  it("rejects JSON objects without a valid root dependencies object", () => {
    for (const stdout of [
      "{}",
      JSON.stringify({ name: "incident-platform", problems: [] }),
      JSON.stringify({ dependencies: null }),
      JSON.stringify({ dependencies: [] }),
      JSON.stringify({ dependencies: "not-a-tree" }),
      JSON.stringify([]),
    ]) {
      assert.throws(
        () => parseNpmLsResult({ status: 0, stdout }, ctx),
        /malformed JSON dependency tree|no valid JSON dependency tree/,
        stdout,
      );
    }
  });

  it("accepts a valid empty dependencies object", () => {
    const parsed = parseNpmLsResult({ status: 0, stdout: JSON.stringify({ name: "empty-project", dependencies: {}, problems: [] }) }, ctx);
    assert.deepEqual(parsed.tree.dependencies, {});
  });

  it("accepts exit code 0 with only lockfile-declared optional extraneous packages, and reports them", () => {
    const { tree, ignored } = parseNpmLsResult({ status: 0, stdout: treeWith([SHARP, EMNAPI]) }, ctx);
    assert.deepEqual(ignored, [SHARP, EMNAPI]);
    assert.deepEqual(findDuplicates(tree, ["react"]), {});
  });

  it("still sees duplicates inside an ignored extraneous node (the tolerance cannot hide a duplicate)", () => {
    const tree = {
      dependencies: {
        react: { version: "19.2.8" },
        "@img/sharp-wasm32": { version: "0.35.5", extraneous: true, dependencies: { react: { version: "18.3.1" } } },
      },
      problems: [SHARP],
    };
    const parsed = parseNpmLsResult({ status: 0, stdout: JSON.stringify(tree) }, ctx);
    assert.deepEqual(parsed.ignored, [SHARP]);
    assert.deepEqual(findDuplicates(parsed.tree, ["react"]), { react: ["18.3.1", "19.2.8"] });
  });

  it("fails when any extraneous package is not provably benign, naming it in the message", () => {
    const stray = `extraneous: left-pad@1.0.0 ${ROOT}/node_modules/left-pad`;
    assert.throws(
      () => parseNpmLsResult({ status: 0, stdout: treeWith([SHARP, stray]) }, ctx),
      (error) => /healthy dependency tree/.test(error.message) && error.message.includes("left-pad@1.0.0") && !error.message.includes("sharp-wasm32"),
    );
  });

  it("fails on missing / invalid problems even when npm exits 0 and the lockfile is readable", () => {
    for (const problem of ["missing: jest@30.5.2, required by @platform/api@0.0.0", `invalid: zod@3.0.0 ${ROOT}/node_modules/zod`, "peer dep missing: react@19, required by x@1.0.0"]) {
      assert.throws(() => parseNpmLsResult({ status: 0, stdout: treeWith([SHARP, problem]) }, ctx), /healthy dependency tree/, problem);
    }
  });

  it("fails on a non-zero exit code even when the output is a JSON tree with no problems", () => {
    assert.throws(() => parseNpmLsResult({ status: 1, stdout: treeWith([]) }, ctx), /healthy dependency tree \(exit code 1\)/);
  });

  it("fails with a JSON-specific message when npm printed nothing or something that is not a JSON object", () => {
    for (const stdout of ["", "   ", "npm ERR! something", "{ not json", "[]", undefined]) {
      assert.throws(() => parseNpmLsResult({ status: 0, stdout }, ctx), /no valid JSON dependency tree/, String(stdout));
    }
  });

  it("fails with a start-specific message when npm could not be run at all", () => {
    assert.throws(() => parseNpmLsResult({ startError: "ENOENT" }, ctx), /could not run npm ls \(ENOENT\)/);
    assert.throws(() => parseNpmLsResult({ startError: "ENOBUFS" }, ctx), /could not run npm ls \(ENOBUFS\)/);
  });

  it("tolerates a UTF-8 byte order mark before the JSON", () => {
    assert.equal(parseNpmLsResult({ status: 0, stdout: `\uFEFF${treeWith([])}` }, ctx).tree.name, "incident-platform");
  });

  it("does not tolerate anything when no lockfile is available", () => {
    assert.throws(() => parseNpmLsResult({ status: 0, stdout: treeWith([SHARP]) }, { lockPackages: null, root: ROOT }), /healthy dependency tree/);
  });
});

describe("validateNpmTree messages", () => {
  it("names the exit code and caps the listed problems", () => {
    const many = Array.from({ length: 8 }, (_, i) => `missing: p${i}@1.0.0`);
    assert.throws(() => validateNpmTree({ problems: many }, 1), (error) => /exit code 1/.test(error.message) && error.message.includes("p4@1.0.0") && !error.message.includes("p5@1.0.0") && /and 3 more/.test(error.message));
  });
});
