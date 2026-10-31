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

function conjuncts(expression: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(expression)) return conjuncts(expression.expression);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  )
    return [...conjuncts(expression.left), ...conjuncts(expression.right)];
  return [expression];
}

function methodAlternatives(expression: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(expression)) return methodAlternatives(expression.expression);
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      return [...methodAlternatives(expression.left), ...methodAlternatives(expression.right)];
    if (
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(expression.left) &&
      expression.left.text === "method" &&
      ts.isStringLiteral(expression.right)
    ) {
      const method = expression.right.text;
      if (!["GET", "POST", "PATCH", "DELETE"].includes(method))
        throw new Error(`Unknown HTTP method: ${method}`);
      return [method];
    }
  }
  throw new Error(`Unknown method predicate: ${expression.getText()}`);
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
  function inventory(node: ts.Node, activeMethods?: ReadonlySet<string>): void {
    if (!ts.isIfStatement(node)) {
      ts.forEachChild(node, (child) => inventory(child, activeMethods));
      return;
    }
    const text = node.expression.getText(file);
    if (text === "!request.method" || text === "method && path") {
      ts.forEachChild(node, (child) => inventory(child, activeMethods));
      return;
    }
    let methods: string[] = [];
    let literalPath: string | undefined;
    const references = new Set<string>();
    for (const part of conjuncts(node.expression)) {
      let usesMethod = false;
      walk(part, (child) => {
        if (ts.isIdentifier(child) && child.text === "method") usesMethod = true;
      });
      if (usesMethod) {
        if (methods.length) throw new Error(`Unknown method predicate: ${text}`);
        methods = methodAlternatives(part);
      }
    }
    walk(node.expression, (part) => {
      if (ts.isIdentifier(part) && declarations.has(part.text)) references.add(part.text);
      if (
        !ts.isBinaryExpression(part) ||
        part.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
      )
        return;
      if (ts.isIdentifier(part.left) && ts.isStringLiteral(part.right)) {
        if (part.left.text === "path") literalPath = part.right.text;
      }
    });
    if (methods.length === 0) {
      ts.forEachChild(node, (child) => inventory(child, activeMethods));
      return;
    }
    if (activeMethods) {
      if (methodAlternatives(node.expression).some((method) => !activeMethods.has(method)))
        throw new Error(`Unknown nested dispatch predicate: ${text}`);
      ts.forEachChild(node, (child) => inventory(child, activeMethods));
      return;
    }
    if (literalPath) {
      if (references.size) throw new Error("Mixed literal/regex route requires contract review");
      for (const method of methods) routes.push(`${method} ${literalPath}`);
    } else {
      if (references.size !== 1)
        throw new Error(`Unknown dispatch predicate: ${node.expression.getText(file)}`);
      const name = references.values().next().value;
      const patterns = name === undefined ? undefined : declarations.get(name);
      if (!patterns) throw new Error("Missing route declaration");
      for (const method of methods) for (const path of patterns) routes.push(`${method} ${path}`);
    }
    inventory(node.thenStatement, new Set(methods));
    if (node.elseStatement) inventory(node.elseStatement);
  }
  inventory(handler);
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
