import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isQualifiedName,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isVariableStatement,
  SyntaxKind,
  type CallExpression,
  type Node,
  type PropertyName,
  type SourceFile,
  type TypeNode,
} from "typescript/unstable/ast";
import { API, DiagnosticCategory } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

/** Transport verbs the generated official resources may call. */
const TRANSPORT_VERBS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "getAPIList",
]);

const VIRTUAL_ROOT = "/open-compute-sdk-scan";

interface ScannedResourceMethod {
  /** Official package module path, e.g. `resources/queues/queues.mjs`. */
  module: string;
  /** Official generated class name, e.g. `BaseQueues`. */
  className: string;
  /** Official resource `_key`, e.g. `["queues"]`. */
  key: string[];
  /** Official method name, e.g. `create`. */
  method: string;
  /** Effective HTTP verb after `method:` overrides, upper-case. */
  httpMethod: string;
  /** Path template with every parameter collapsed to `{}`. */
  pathTemplate: string;
}

interface ScannedDeclaration {
  /** Paired declaration module path, e.g. `resources/queues/queues.d.ts`. */
  module: string;
  className: string;
  method: string;
  /** Number of overload declarations with this name in the class. */
  overloads: number;
  /** Module-local exported type names reachable from the signature. */
  typeNames: string[];
}

export interface ScanResult {
  /** Runtime methods indexed by `<module>::<className>::<method>`. */
  methods: Map<string, ScannedResourceMethod>;
  /** Signature declarations indexed by the same composite key. */
  declarations: Map<string, ScannedDeclaration>;
  /** Module-local exported type names, indexed by `.d.ts` module path. */
  exportedTypes: Map<string, Set<string>>;
}

function listFiles(dir: string, suffixes: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, suffixes));
    else if (suffixes.some((suffix) => entry.name.endsWith(suffix)))
      out.push(path);
  }
  return out;
}

function nameText(name: PropertyName | Node): string | undefined {
  if (
    isIdentifier(name) ||
    isStringLiteral(name) ||
    isNumericLiteral(name) ||
    isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return undefined;
}

function templateText(node: Node): string | undefined {
  if (isStringLiteral(node)) return node.text;
  if (isTaggedTemplateExpression(node)) {
    const template = node.template;
    if (isNoSubstitutionTemplateLiteral(template)) return template.text;
    if (isTemplateExpression(template)) return template.getText().slice(1, -1);
    return undefined;
  }
  if (isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (isTemplateExpression(node)) return node.getText().slice(1, -1);
  return undefined;
}

/** Collapse every template hole so SDK templates match OpenAPI paths. */
function normalizePath(raw: string): string {
  return raw.replaceAll(/\$\{[^}]*\}/g, "{}");
}

/**
 * Detect an explicit `method: '<verb>'` override inside the request-options
 * argument; the official SDK uses it on `getAPIList` calls that really issue
 * POST requests.
 */
function methodOverride(call: CallExpression): string | undefined {
  for (const argument of call.arguments) {
    if (!isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!isPropertyAssignment(property)) continue;
      if (nameText(property.name) !== "method") continue;
      if (isStringLiteral(property.initializer))
        return property.initializer.text.toUpperCase();
    }
  }
  return undefined;
}

function transportCall(node: Node): { verb: string; path: string } | undefined {
  if (!isCallExpression(node)) return undefined;
  const expression = node.expression;
  if (!isPropertyAccessExpression(expression)) return undefined;
  const target = expression.expression.getText();
  const verb = nameText(expression.name);
  if (target !== "this._client" || verb === undefined) return undefined;
  if (!TRANSPORT_VERBS.has(verb)) return undefined;
  const argument = node.arguments[0];
  if (argument === undefined) return undefined;
  const rawPath = templateText(argument);
  if (rawPath === undefined) return undefined;
  const override = methodOverride(node);
  if (verb !== "getAPIList" && override !== undefined) {
    throw new Error(
      `official resource method overrides ${verb} with ${override}; upgrade the scanner`,
    );
  }
  const effective =
    override ?? (verb === "getAPIList" ? "GET" : verb.toUpperCase());
  return { verb: effective, path: normalizePath(rawPath) };
}

function literalKey(node: Node): string[] | undefined {
  if (isCallExpression(node)) {
    if (node.expression.getText() !== "Object.freeze") return undefined;
    const argument = node.arguments[0];
    return argument === undefined ? undefined : literalKey(argument);
  }
  if (isArrayLiteralExpression(node)) {
    const key: string[] = [];
    for (const element of node.elements) {
      if (!isStringLiteral(element)) return undefined;
      key.push(element.text);
    }
    return key;
  }
  return undefined;
}

/** `_key` is assigned after each class inside the generated IIFE wrappers. */
function collectResourceKeys(source: SourceFile): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  const visit = (node: Node): void => {
    if (isExpressionStatement(node) && isBinaryExpression(node.expression)) {
      const assignment = node.expression;
      if (
        assignment.operatorToken.kind === SyntaxKind.EqualsToken &&
        isPropertyAccessExpression(assignment.left) &&
        nameText(assignment.left.name) === "_key"
      ) {
        const key = literalKey(assignment.right);
        const target = assignment.left.expression.getText();
        if (key !== undefined && !keys.has(target)) keys.set(target, key);
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return keys;
}

function typeReferenceNames(node: Node, names: Set<string>): void {
  if (isTypeReferenceNode(node)) {
    const typeName = isQualifiedName(node.typeName)
      ? node.typeName.left
      : node.typeName;
    if (isIdentifier(typeName)) names.add(typeName.text);
  }
  node.forEachChild((child) => typeReferenceNames(child, names));
}

function scanRuntimeModule(
  source: SourceFile,
  module: string,
): ScannedResourceMethod[] {
  const methods: ScannedResourceMethod[] = [];
  const keys = collectResourceKeys(source);
  const visit = (node: Node): void => {
    if (isClassDeclaration(node) && node.name !== undefined) {
      const key = keys.get(node.name.text);
      if (key !== undefined) {
        for (const member of node.members) {
          if (!isMethodDeclaration(member)) continue;
          const method = nameText(member.name);
          if (method === undefined || member.body === undefined) continue;
          let call: { verb: string; path: string } | undefined;
          const walk = (child: Node): void => {
            if (call !== undefined) return;
            call = transportCall(child);
            if (call !== undefined) return;
            child.forEachChild(walk);
          };
          member.body.forEachChild(walk);
          if (call !== undefined) {
            methods.push({
              module,
              className: node.name.text,
              key,
              method,
              httpMethod: call.verb,
              pathTemplate: call.path,
            });
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return methods;
}

function hasExportModifier(node: Node): boolean {
  return (
    (node as { modifiers?: readonly Node[] }).modifiers?.some(
      (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

function topLevelExportedTypes(source: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    const statementName = (statement as { name?: { text: string } }).name;
    if (
      (isInterfaceDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        isEnumDeclaration(statement) ||
        isFunctionDeclaration(statement) ||
        isClassDeclaration(statement) ||
        isModuleDeclaration(statement)) &&
      hasExportModifier(statement) &&
      statementName !== undefined
    ) {
      names.add(statementName.text);
    }
    if (isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
    if (isExportDeclaration(statement) && statement.exportClause) {
      const bindings = statement.exportClause as {
        elements?: Array<{ name: { text: string } }>;
      };
      for (const element of bindings.elements ?? []) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function declarationsByName(source: SourceFile, name: string): Node[] {
  const found: Node[] = [];
  for (const statement of source.statements) {
    const statementName = (statement as { name?: { text: string } }).name;
    if (statementName?.text === name) found.push(statement);
  }
  return found;
}

function scanDeclarationModule(
  source: SourceFile,
  module: string,
): {
  exportedTypes: Set<string>;
  declarations: Map<string, Map<string, ScannedDeclaration>>;
} {
  const exportedTypes = topLevelExportedTypes(source);
  const declarations = new Map<string, Map<string, ScannedDeclaration>>();
  const visit = (node: Node): void => {
    if (isClassDeclaration(node) && node.name !== undefined) {
      const counts = new Map<string, number>();
      const signatureTypes = new Map<string, Set<string>>();
      for (const member of node.members) {
        if (!isMethodDeclaration(member)) continue;
        const method = nameText(member.name);
        if (method === undefined) continue;
        counts.set(method, (counts.get(method) ?? 0) + 1);
        const names = new Set<string>();
        for (const parameter of member.parameters) {
          const type: TypeNode | undefined = parameter.type;
          if (type !== undefined) typeReferenceNames(type, names);
        }
        if (member.type !== undefined) typeReferenceNames(member.type, names);
        const existing = signatureTypes.get(method) ?? new Set<string>();
        for (const name of names) existing.add(name);
        signatureTypes.set(method, existing);
      }
      const classDeclarations = declarations.get(node.name.text) ?? new Map();
      for (const [method, names] of signatureTypes) {
        classDeclarations.set(method, {
          module,
          className: node.name.text,
          method,
          overloads: counts.get(method) ?? 1,
          typeNames: [...names],
        });
      }
      declarations.set(node.name.text, classDeclarations);
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return { exportedTypes, declarations };
}

/**
 * Statically parse the pinned official `cloudflare` package with the
 * TypeScript compiler. Package sources are only ever parsed, never executed.
 */
export async function scanOfficialPackage(
  packageRoot: string,
): Promise<ScanResult> {
  const resourcesRoot = join(packageRoot, "resources");
  const mjsFiles = listFiles(resourcesRoot, [".mjs"]);
  const dtsFiles = listFiles(resourcesRoot, [".d.ts"]);
  const entries: Record<string, string> = {};
  const paths: string[] = [];
  for (const path of [...mjsFiles, ...dtsFiles]) {
    const virtual = `${VIRTUAL_ROOT}/${relative(packageRoot, path)}`;
    entries[virtual] = readFileSync(path, "utf8");
    paths.push(virtual);
  }
  entries[`${VIRTUAL_ROOT}/tsconfig.json`] = `${JSON.stringify({
    files: paths,
    compilerOptions: {
      noEmit: true,
      skipLibCheck: true,
      types: [],
      lib: [],
      strict: true,
      allowJs: true,
      checkJs: false,
    },
  })}\n`;

  const api = new API({
    cwd: VIRTUAL_ROOT,
    fs: createVirtualFileSystem(entries),
  });
  try {
    const snapshot = await api.updateSnapshot({
      openProjects: [`${VIRTUAL_ROOT}/tsconfig.json`],
    });
    const project = snapshot.getProjects()[0];
    if (project === undefined)
      throw new Error("TypeScript did not open the official SDK project");
    const diagnostics = [
      ...(await project.program.getSyntacticDiagnostics()),
      ...(await project.program.getBindDiagnostics()),
    ].filter((diagnostic) => diagnostic.category === DiagnosticCategory.Error);
    if (diagnostics.length > 0) {
      throw new Error(
        `official SDK sources did not parse cleanly: ${diagnostics
          .slice(0, 5)
          .map((diagnostic) => diagnostic.text)
          .join("; ")}`,
      );
    }

    const sources = new Map<string, SourceFile>();
    for (const path of [...dtsFiles, ...mjsFiles]) {
      const module = relative(packageRoot, path);
      const source = await project.program.getSourceFile(
        `${VIRTUAL_ROOT}/${module}`,
      );
      if (source === undefined)
        throw new Error(`TypeScript did not parse ${module}`);
      sources.set(module, source as SourceFile);
    }

    const methods = new Map<string, ScannedResourceMethod>();
    for (const [module, source] of sources) {
      if (!module.endsWith(".mjs")) continue;
      for (const method of scanRuntimeModule(source, module)) {
        const id = `${method.module}::${method.className}::${method.method}`;
        const existing = methods.get(id);
        if (
          existing !== undefined &&
          (existing.pathTemplate !== method.pathTemplate ||
            existing.httpMethod !== method.httpMethod)
        ) {
          throw new Error(
            `official SDK runtime defines conflicting implementations for ${id}`,
          );
        }
        methods.set(id, method);
      }
    }

    const exportedTypes = new Map<string, Set<string>>();
    const classDeclarations = new Map<
      string,
      Map<string, Map<string, ScannedDeclaration>>
    >();
    for (const [module, source] of sources) {
      if (!module.endsWith(".d.ts")) continue;
      const scanned = scanDeclarationModule(source, module);
      exportedTypes.set(module, scanned.exportedTypes);
      classDeclarations.set(module, scanned.declarations);
    }

    const declarations = new Map<string, ScannedDeclaration>();
    for (const [module, classes] of classDeclarations) {
      const localExports = exportedTypes.get(module);
      const source = sources.get(module);
      if (localExports === undefined || source === undefined) continue;
      const runtimeModule = `${module.replace(/\.d\.ts$/, "")}.mjs`;
      for (const [className, methodDeclarations] of classes) {
        for (const [method, declaration] of methodDeclarations) {
          const closure = new Set<string>();
          const queue = [...declaration.typeNames];
          while (queue.length > 0) {
            const name = queue.pop();
            if (name === undefined || closure.has(name)) continue;
            if (!localExports.has(name)) continue;
            closure.add(name);
            for (const statement of declarationsByName(source, name)) {
              const refs = new Set<string>();
              typeReferenceNames(statement, refs);
              for (const ref of refs) queue.push(ref);
            }
          }
          declarations.set(`${runtimeModule}::${className}::${method}`, {
            ...declaration,
            typeNames: [...closure].sort(),
          });
        }
      }
    }
    return { methods, declarations, exportedTypes };
  } finally {
    await api.close();
  }
}
