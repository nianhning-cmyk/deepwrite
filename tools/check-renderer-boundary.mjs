import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import {
  collectModuleReferences,
  collectValueExportNamesDeep,
  extractScriptBlocks,
  isForbiddenRuntimeSpecifier,
  parseSource,
  resolvesOutsideRenderer
} from "./renderer-boundary-analysis.mjs";

/**
 * Enforces the Renderer process boundary.
 *
 * 1. Renderer sources may not evaluate Node builtins (bare, `node:`-prefixed, or
 *    subpaths such as `fs/promises`), Electron, SQLite, `conversation-storage`, or
 *    the Pi agent runtime. Type-only imports are allowed: the compiler erases them.
 * 2. Relative imports may not resolve outside `apps/desktop/src/renderer`; reaching
 *    into Main/Utility code that way skips the alias that keeps the Renderer on the
 *    renderer-safe contract surface.
 * 3. A runtime value imported from `@deepwrite/contracts` must be exported by
 *    `packages/contracts/src/renderer.ts`, which is what the Renderer build aliases
 *    that specifier to. A missing export fails WorkspaceShell module load and shows
 *    a blank window.
 *
 * Imports are read from the TypeScript AST, so comments and string literals that
 * merely look like imports are not reported.
 */

const repoRoot = resolve(import.meta.dirname, "..");
const rendererRoot = resolve(repoRoot, "apps/desktop/src/renderer");
const contractsRendererFile = resolve(
  repoRoot,
  "packages/contracts/src/renderer.ts"
);
const allowedExtensions = new Set([".ts", ".vue"]);
const contractModuleExtensions = [".ts", ".d.ts", "/index.ts"];

function isTestFile(relPath) {
  return relPath.includes(".test.");
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else if (allowedExtensions.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

const moduleSourceCache = new Map();

function readContractModule(fileName) {
  if (moduleSourceCache.has(fileName)) return moduleSourceCache.get(fileName);
  let source = null;
  try {
    source = readFileSync(fileName, "utf8");
  } catch {
    // A specifier that does not resolve contributes no exports; the caller
    // reports the unresolved module itself.
  }
  moduleSourceCache.set(fileName, source);
  return source;
}

function resolveContractModule(specifier, fromFileName) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(fromFileName, "..", specifier);
  for (const extension of contractModuleExtensions) {
    const candidate = `${base}${extension}`;
    if (readContractModule(candidate) !== null) return candidate;
  }
  return null;
}

function scriptBlocksOf(file, source) {
  if (extname(file) !== ".vue") return [{ text: source, lineOffset: 0 }];
  return extractScriptBlocks(source);
}

const rendererExports = collectValueExportNamesDeep(
  parseSource(readFileSync(contractsRendererFile, "utf8"), {
    fileName: contractsRendererFile
  }),
  { readModule: readContractModule, resolveModule: resolveContractModule }
);

const files = await collectFiles(rendererRoot);
const violations = [];
const missingContractExports = new Map();

for (const file of files) {
  const relPath = relative(repoRoot, file);
  const isTest = isTestFile(relPath);
  const source = await readFile(file, "utf8");

  for (const block of scriptBlocksOf(file, source)) {
    const sourceFile = parseSource(block.text, { fileName: file });
    for (const reference of collectModuleReferences(sourceFile, {
      lineOffset: block.lineOffset
    })) {
      const location = `${relPath}:${reference.line}`;

      if (
        !reference.typeOnly &&
        isForbiddenRuntimeSpecifier(reference.specifier)
      ) {
        violations.push(
          `${location} imports forbidden renderer module ${reference.specifier}`
        );
      }

      if (
        !isTest &&
        reference.specifier.startsWith(".") &&
        resolvesOutsideRenderer(file, reference.specifier, rendererRoot)
      ) {
        violations.push(
          `${location} imports ${reference.specifier}, which resolves outside the Renderer tree. Renderer code may only import from its own directory, @deepwrite/contracts, or @deepwrite/shared.`
        );
      }

      if (isTest || reference.typeOnly) continue;
      if (reference.specifier !== "@deepwrite/contracts") continue;
      for (const name of reference.valueNames) {
        if (name === "*" || rendererExports.has(name)) continue;
        const list = missingContractExports.get(name) ?? [];
        list.push(location);
        missingContractExports.set(name, list);
      }
    }
  }
}

for (const [name, usedBy] of [...missingContractExports.entries()].sort()) {
  violations.push(
    `Renderer imports runtime value ${name} from @deepwrite/contracts, but packages/contracts/src/renderer.ts does not export it (${usedBy.join(", ")}). This fails WorkspaceShell module load and shows a blank window.`
  );
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(
  "Renderer boundary check passed: no Node, Electron, SQLite, or Pi runtime imports (including subpaths and dynamic imports), no imports escaping the Renderer tree, and contracts renderer exports cover Renderer value imports."
);
