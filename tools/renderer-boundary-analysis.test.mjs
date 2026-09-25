import { describe, expect, it } from "vitest";
import {
  collectModuleReferences,
  collectValueExportNames,
  collectValueExportNamesDeep,
  extractScriptBlocks,
  isForbiddenRuntimeSpecifier,
  parseSource,
  resolvesOutsideRenderer
} from "./renderer-boundary-analysis.mjs";

function referencesOf(source, options) {
  return collectModuleReferences(parseSource(source, options), options);
}

describe("renderer boundary analysis", () => {
  it("rejects Node builtins including the subpaths and prefixes a name list misses", () => {
    expect(isForbiddenRuntimeSpecifier("fs/promises")).toBe(true);
    expect(isForbiddenRuntimeSpecifier("node:fs")).toBe(true);
    expect(isForbiddenRuntimeSpecifier("node:fs/promises")).toBe(true);
    expect(isForbiddenRuntimeSpecifier("path/posix")).toBe(true);
    expect(isForbiddenRuntimeSpecifier("worker_threads")).toBe(true);
    expect(isForbiddenRuntimeSpecifier("better-sqlite3")).toBe(true);
    expect(isForbiddenRuntimeSpecifier("electron")).toBe(true);
    expect(isForbiddenRuntimeSpecifier("@earendil-works/pi-ai")).toBe(true);
    expect(isForbiddenRuntimeSpecifier("@earendil-works/pi-agent-core")).toBe(
      true
    );
    expect(isForbiddenRuntimeSpecifier("@deepwrite/pi-runtime-adapter")).toBe(
      true
    );
  });

  it("allows ordinary renderer dependencies", () => {
    expect(isForbiddenRuntimeSpecifier("vue")).toBe(false);
    expect(isForbiddenRuntimeSpecifier("pinia")).toBe(false);
    expect(isForbiddenRuntimeSpecifier("@deepwrite/contracts")).toBe(false);
    expect(isForbiddenRuntimeSpecifier("@deepwrite/shared")).toBe(false);
  });

  it("finds the import forms a specifier regex cannot see", () => {
    const references = referencesOf(
      [
        'import fs from "fs/promises";',
        'import "node:fs";',
        'const lazy = await import("node:os");',
        'const legacy = require("child_process");',
        'import type { BrowserWindow } from "electron";',
        'import { app } from "electron";'
      ].join("\n")
    );
    const specifiers = references.map((reference) => reference.specifier);
    expect(specifiers).toEqual([
      "fs/promises",
      "node:fs",
      "node:os",
      "child_process",
      "electron",
      "electron"
    ]);
    expect(references[0].typeOnly).toBe(false);
    expect(references[1].typeOnly).toBe(false);
    expect(references[4].typeOnly).toBe(true);
    expect(references[5].typeOnly).toBe(false);
  });

  it("ignores comments and string literals that only look like imports", () => {
    const references = referencesOf(
      [
        '// import electron from "electron"',
        '/* import "node:fs" */',
        "const assertion = 'import \"node:fs\"';",
        'const message = `from "electron"`;'
      ].join("\n")
    );
    expect(references).toEqual([]);
  });

  it("reports imported value names but not type-only specifiers", () => {
    const [reference] = referencesOf(
      'import { type A, b, c as d } from "@deepwrite/contracts";'
    );
    expect(reference.valueNames).toEqual(["b", "c"]);
  });

  it("offsets line numbers by the enclosing script block of a component", () => {
    const source = [
      "<template>",
      "  <div />",
      "</template>",
      "",
      "<script setup lang='ts'>",
      'import "node:fs";',
      "</script>"
    ].join("\n");
    const [block] = extractScriptBlocks(source);
    const [reference] = collectModuleReferences(parseSource(block.text), {
      lineOffset: block.lineOffset
    });
    expect(reference.specifier).toBe("node:fs");
    expect(reference.line).toBe(6);
  });

  it("treats relative imports that leave the renderer tree as violations", () => {
    const rendererRoot = "/repo/apps/desktop/src/renderer";
    const fromFile = `${rendererRoot}/src/composables/useThing.ts`;
    expect(
      resolvesOutsideRenderer(fromFile, "../../types/x", rendererRoot)
    ).toBe(false);
    expect(resolvesOutsideRenderer(fromFile, "./sibling", rendererRoot)).toBe(
      false
    );
    expect(
      resolvesOutsideRenderer(
        fromFile,
        "../../../../utilities/core-entry.js",
        rendererRoot
      )
    ).toBe(true);
  });

  it("collects value exports and leaves type-only exports out", () => {
    const { names, starReExports } = collectValueExportNames(
      parseSource(
        [
          "export const value = 1;",
          "export function helper() {}",
          "export type OnlyType = string;",
          "export interface Shape {}",
          "export { value as aliased };",
          'export type * from "./types";',
          'export * from "./runtime";',
          'export { hidden } from "./other";'
        ].join("\n")
      )
    );
    expect([...names].sort()).toEqual(["aliased", "helper", "hidden", "value"]);
    expect(starReExports).toEqual(["./runtime"]);
  });

  it("follows star re-exports, including through a cycle", () => {
    const modules = {
      "/contracts/renderer.ts": 'export * from "./a";\nexport const own = 1;',
      "/contracts/a.ts": 'export * from "./b";\nexport const fromA = 1;',
      "/contracts/b.ts": 'export * from "./a";\nexport const fromB = 1;'
    };
    const names = collectValueExportNamesDeep(
      parseSource(modules["/contracts/renderer.ts"], {
        fileName: "/contracts/renderer.ts"
      }),
      {
        readModule: (fileName) => modules[fileName] ?? null,
        resolveModule: (specifier, _fromFileName) =>
          specifier === "./a"
            ? "/contracts/a.ts"
            : specifier === "./b"
              ? "/contracts/b.ts"
              : null
      }
    );
    expect([...names].sort()).toEqual(["fromA", "fromB", "own"]);
  });
});
