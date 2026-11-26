// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { JsConfigPathsPlugin } from "next/dist/build/webpack/plugins/jsconfig-paths-plugin.js";
import nextConfig from "../../next.config.js";

const require = createRequire(import.meta.url);
const webDir = resolve(import.meta.dirname, "../..");
const tsconfig = ts.readConfigFile(resolve(webDir, "tsconfig.json"), ts.sys.readFile);
if (tsconfig.error)
  throw new Error(ts.flattenDiagnosticMessageText(tsconfig.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, webDir);
const webpackConfigPath = require.resolve("next/dist/build/webpack-config.js");
const webpackConfigSource = ts.createSourceFile(
  webpackConfigPath,
  readFileSync(webpackConfigPath, "utf8"),
  ts.ScriptTarget.Latest,
);
let extensions: string[] | undefined;
function readResolveDefaults(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(webpackConfigSource) === "resolveConfig"
  ) {
    if (!node.initializer || !ts.isObjectLiteralExpression(node.initializer)) return;
    const property = node.initializer.properties.find(
      (entry) => entry.name?.getText(webpackConfigSource) === "extensions",
    );
    if (
      property &&
      ts.isPropertyAssignment(property) &&
      ts.isArrayLiteralExpression(property.initializer)
    ) {
      extensions = property.initializer.elements
        .filter(ts.isStringLiteral)
        .map((entry) => entry.text);
    }
  }
  ts.forEachChild(node, readResolveDefaults);
}
readResolveDefaults(webpackConfigSource);
if (!extensions?.includes(".ts")) throw new Error("Next resolver extensions not found");
expect(nextConfig).not.toHaveProperty("experimental.extensionAlias");

interface Resolver {
  resolve(
    context: object,
    directory: string,
    request: string,
    resolveContext: object,
    callback: (error: Error | null, result?: string | false) => void,
  ): void;
}

const bundledWebpack = require("next/dist/compiled/webpack/webpack.js") as {
  init(): void;
  webpack(options: object): {
    resolverFactory: { get(type: "normal"): Resolver };
    close(callback: (error?: Error) => void): void;
  };
};
bundledWebpack.init();
// Read Next's extension search order; use its alias plugin without running a compilation.
const compiler = bundledWebpack.webpack({
  mode: "none",
  cache: false,
  resolve: {
    extensions,
    plugins: [
      new JsConfigPathsPlugin(parsed.options.paths ?? {}, { baseUrl: webDir, isImplicit: true }),
    ],
  },
});
const resolver = compiler.resolverFactory.get("normal");
afterAll(
  () =>
    new Promise<void>((done, reject) =>
      compiler.close((error) => (error ? reject(error) : done())),
    ),
);

describe("tag consumer imports in Next's webpack resolver", () => {
  it.each(["FiltersModal.tsx", "TagEditor.tsx"])("resolves %s tag recipe", async (filename) => {
    const consumer = resolve(webDir, "src/components", filename);
    const source = ts.createSourceFile(
      consumer,
      readFileSync(consumer, "utf8"),
      ts.ScriptTarget.Latest,
    );
    const imports = source.statements.filter(ts.isImportDeclaration);
    const tagImport = imports.find((statement) =>
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.some(
            (element) => element.name.text === "tagChipStyle",
          )
        : false,
    );
    expect(tagImport).toBeDefined();
    if (!tagImport || !ts.isStringLiteral(tagImport.moduleSpecifier)) {
      throw new Error("Missing tag recipe import");
    }
    const request = tagImport.moduleSpecifier.text;
    const resolved = await new Promise<string | false | undefined>((resolveImport, reject) => {
      resolver.resolve({}, dirname(consumer), request, {}, (error, result) => {
        if (error) reject(error);
        else resolveImport(result);
      });
    });
    expect(resolved).toBe(resolve(webDir, "src/design/tag.ts"));
  });
});
