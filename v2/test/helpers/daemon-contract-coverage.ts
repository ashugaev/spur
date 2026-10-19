import { createHash } from "node:crypto";
import ts from "typescript";

function sourceFile(source: string): ts.SourceFile {
  const file = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics.length) throw new Error("Cannot inventory syntactically invalid contract source");
  return file;
}

/** Include parser bodies, DTO references and nested declarations; ignore comments/formatting. */
export function contractFingerprint(source: string): string {
  const file = sourceFile(source);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  return createHash("sha256").update(printer.printFile(file)).digest("hex");
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function routePatterns(expression: ts.Expression): string[] {
  let regex: ts.RegularExpressionLiteral | undefined;
  walk(expression, (node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      if (regex) throw new Error("Multiple regexes in path declaration require contract review");
      regex = node;
    }
  });
  if (!regex) return [];
  const literal = regex.getText();
  if (!literal.startsWith("/^") || !literal.endsWith("$/")) {
    throw new Error(`Unanchored or flagged route regex requires contract review: ${literal}`);
  }
  let pattern = literal.slice(2, -2).replaceAll("\\/", "/");
  pattern = pattern.replaceAll("([^/]+)", "{}").replaceAll("(.+)", "{*}");
  const alternatives = pattern.match(/\(([a-z-]+(?:\|[a-z-]+)+)\)/);
  const choices = alternatives?.[1];
  const values =
    alternatives && choices
      ? choices.split("|").map((alternative) => pattern.replace(alternatives[0], alternative))
      : [pattern];
  if (values.some((value) => [..."()|\\?+[]"].some((character) => value.includes(character)))) {
    throw new Error(`Unknown route regex syntax requires contract review: ${literal}`);
  }
  return values;
}

export function inventoryDaemonRoutes(source: string): string[] {
  const file = sourceFile(source);
  let handler: ts.ArrowFunction | undefined;
  walk(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "handleRequest" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    )
      handler = node.initializer;
  });
  if (!handler) throw new Error("Daemon handleRequest arrow function not found");
  const declarations = new Map<string, string[]>();
  walk(handler, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    if (!node.initializer.getText(file).includes("path.match(")) return;
    const patterns = routePatterns(node.initializer);
    if (!patterns.length) throw new Error(`Unrecognized path matcher: ${node.name.text}`);
    declarations.set(node.name.text, patterns);
  });
  const routes: string[] = [];
  walk(handler, (node) => {
    if (!ts.isIfStatement(node)) return;
    let method: string | undefined;
    const literalPaths = new Set<string>();
    const references = new Set<string>();
    walk(node.expression, (part) => {
      if (ts.isIdentifier(part) && declarations.has(part.text)) references.add(part.text);
      if (
        !ts.isBinaryExpression(part) ||
        part.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
      )
        return;
      if (ts.isIdentifier(part.left) && ts.isStringLiteral(part.right)) {
        if (part.left.text === "method") method = part.right.text;
        if (part.left.text === "path") literalPaths.add(part.right.text);
      }
    });
    if (!method) {
      // An unfamiliar comparison involving method cannot silently evade the inventory.
      if (
        /\bmethod\b/.test(node.expression.getText(file)) &&
        node.expression.getText(file) !== "!request.method" &&
        node.expression.getText(file) !== "method && path"
      ) {
        throw new Error(`Unknown method predicate: ${node.expression.getText(file)}`);
      }
      return;
    }
    if (!["GET", "POST", "PATCH", "DELETE"].includes(method))
      throw new Error(`Unknown HTTP method: ${method}`);
    if (literalPaths.size) {
      if (references.size) throw new Error("Mixed literal/regex route requires contract review");
      for (const path of literalPaths) routes.push(`${method} ${path}`);
    } else {
      if (references.size !== 1)
        throw new Error(`Unknown dispatch predicate: ${node.expression.getText(file)}`);
      const name = references.values().next().value;
      const patterns = name === undefined ? undefined : declarations.get(name);
      if (!patterns) throw new Error("Missing route declaration");
      for (const path of patterns) routes.push(`${method} ${path}`);
    }
  });
  if (new Set(routes).size !== routes.length)
    throw new Error("Duplicate daemon routes require contract review");
  return routes.sort();
}

export function interfaceFields(
  source: string,
  name: string,
): { name: string; required: boolean }[] {
  const file = sourceFile(source);
  const declaration = file.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === name,
  );
  if (!declaration || !ts.isInterfaceDeclaration(declaration) || declaration.heritageClauses)
    throw new Error(`Unsupported or absent DTO: ${name}`);
  return declaration.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name))
      throw new Error(`Unsupported DTO field: ${name}`);
    return { name: member.name.text, required: !member.questionToken };
  });
}
