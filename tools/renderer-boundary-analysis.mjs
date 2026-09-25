import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Static analysis for the Renderer process boundary.
 *
 * Everything here is pure: sources, plus a module reader supplied by the caller.
 * The CLI in `check-renderer-boundary.mjs` owns file walking and path resolution,
 * so these rules can be unit-tested against fixtures (see
 * `renderer-boundary-analysis.test.mjs`) rather than only against the real tree.
 */

const NODE_BUILTINS = new Set(
  builtinModules.map((name) =>
    name.startsWith("node:") ? name.slice(5) : name
  )
);

/** Packages that exist only for Main/Utility processes or the agent runtime. */
const FORBIDDEN_PACKAGE_PATTERNS = [
  /^electron$/,
  /^better-sqlite3$/,
  /^sqlite3(?:\/|$)/,
  /conversation-storage(?:\/|$)/,
  /pi-agent-core/,
  /pi-ai/,
  /pi-runtime-adapter/
];

/**
 * True for specifiers the Renderer must never evaluate: Node builtins (bare,
 * `node:`-prefixed, or a subpath such as `fs/promises`) and Main-only packages.
 */
export function isForbiddenRuntimeSpecifier(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(specifier)) return true;
  const root = specifier.split("/")[0];
  if (root && NODE_BUILTINS.has(root)) return true;
  return FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(specifier));
}

const SCRIPT_BLOCK_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;

/**
 * Script bodies of a single-file component, each with the line offset needed to
 * report original line numbers.
 */
export function extractScriptBlocks(source) {
  const blocks = [];
  for (const match of source.matchAll(SCRIPT_BLOCK_PATTERN)) {
    const body = match[2];
    if (body === undefined || body.trim() === "") continue;
    const start = match.index + match[0].indexOf(body);
    const lineOffset = source.slice(0, start).split("\n").length - 1;
    blocks.push({ text: body, lineOffset });
  }
  return blocks;
}

export function parseSource(source, { fileName = "module.ts" } = {}) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS
  );
}

function moduleSpecifierText(node) {
  const specifier = node.moduleSpecifier;
  if (specifier && ts.isStringLiteralLike(specifier)) return specifier.text;
  return null;
}

function importEqualsSpecifier(node) {
  const ref = node.moduleReference;
  if (!ts.isExternalModuleReference(ref)) return null;
  const expression = ref.expression;
  return expression && ts.isStringLiteralLike(expression)
    ? expression.text
    : null;
}

/**
 * Every module reference in a source file: static imports, re-exports, `import =`
 * declarations, dynamic `import()`, and `require()`. String literals that merely
 * look like imports (test assertions, comments) are not module references, which
 * is the point of parsing instead of matching text.
 */
export function collectModuleReferences(sourceFile, { lineOffset = 0 } = {}) {
  const references = [];

  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1 +
    lineOffset;

  const push = (node, specifier, { typeOnly, valueNames = [] }) => {
    if (!specifier) return;
    references.push({
      specifier,
      typeOnly: Boolean(typeOnly),
      valueNames,
      line: lineOf(node)
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const valueNames = [];
      if (clause && !clause.isTypeOnly) {
        if (clause.name) valueNames.push("default");
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            valueNames.push("*");
          } else {
            for (const element of clause.namedBindings.elements) {
              if (element.isTypeOnly) continue;
              valueNames.push((element.propertyName ?? element.name).text);
            }
          }
        }
      }
      push(node, moduleSpecifierText(node), {
        typeOnly: Boolean(clause?.isTypeOnly),
        valueNames
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const valueNames = [];
      if (!node.isTypeOnly && clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          valueNames.push((element.propertyName ?? element.name).text);
        }
      }
      push(node, moduleSpecifierText(node), {
        typeOnly: Boolean(node.isTypeOnly),
        valueNames
      });
    } else if (ts.isImportEqualsDeclaration(node)) {
      push(node, importEqualsSpecifier(node), {
        typeOnly: Boolean(node.isTypeOnly)
      });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const [first] = node.arguments;
      push(node, first && ts.isStringLiteralLike(first) ? first.text : null, {
        typeOnly: false
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

function exportedNameOf(element) {
  const name = element.name;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? name.text
    : null;
}

function collectBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element))
        collectBindingNames(element.name, names);
    }
  }
}

/** Types have no runtime value, and ambient declarations have no emitted binding. */
function isValueDeclaration(statement) {
  if (ts.isInterfaceDeclaration(statement)) return false;
  if (ts.isTypeAliasDeclaration(statement)) return false;
  const modifiers = ts.canHaveModifiers(statement)
    ? ts.getModifiers(statement)
    : undefined;
  return !modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword
  );
}

/**
 * Names this module exports as runtime values. Type-only exports are excluded;
 * star re-exports are returned separately so the caller can follow them.
 */
export function collectValueExportNames(sourceFile) {
  const names = new Set();
  const starReExports = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        const specifier = moduleSpecifierText(statement);
        if (specifier && !statement.isTypeOnly) starReExports.push(specifier);
        continue;
      }
      if (statement.isTypeOnly) continue;
      if (ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text);
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const name = exportedNameOf(element);
        if (name) names.add(name);
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    if (
      !modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    ) {
      continue;
    }
    if (
      modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword
      )
    ) {
      names.add("default");
      continue;
    }
    if (!isValueDeclaration(statement)) continue;

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      continue;
    }

    const name = statement.name;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) {
      names.add(name.text);
    }
  }

  return { names, starReExports };
}

/**
 * Value exports including those reached through `export * from`, which the
 * Renderer's contract entry point relies on. Cycles are tolerated.
 *
 * `readModule(fileName)` returns source text or null; `resolveModule(specifier,
 * fromFileName)` returns a file name or null.
 */
export function collectValueExportNamesDeep(
  sourceFile,
  { readModule, resolveModule, visited = new Set() }
) {
  const names = new Set();
  if (visited.has(sourceFile.fileName)) return names;
  visited.add(sourceFile.fileName);

  const { names: ownNames, starReExports } =
    collectValueExportNames(sourceFile);
  for (const name of ownNames) names.add(name);

  for (const specifier of starReExports) {
    const target = resolveModule(specifier, sourceFile.fileName);
    if (!target) continue;
    const source = readModule(target);
    if (source === null) continue;
    const targetSource = parseSource(source, { fileName: target });
    for (const name of collectValueExportNamesDeep(targetSource, {
      readModule,
      resolveModule,
      visited
    })) {
      names.add(name);
    }
  }

  return names;
}

/**
 * True when a relative specifier from `fromFile` resolves outside the Renderer
 * tree. Such imports bypass the alias that keeps the Renderer on the
 * renderer-safe contract surface.
 */
export function resolvesOutsideRenderer(fromFile, specifier, rendererRoot) {
  const target = resolve(dirname(fromFile), specifier);
  const relativeToRoot = relative(rendererRoot, target);
  return relativeToRoot.startsWith("..") || relativeToRoot === "";
}
