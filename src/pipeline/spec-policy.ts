import path from "node:path";
import ts from "typescript";
import type { RunContext } from "../core/types.js";
import { existsContained, readTextContained } from "../utils/fs.js";

export type SpecPolicyIssue = { rule: string; detail: string };

export type SpecPolicyOptions = {
  fallback?: boolean;
  targetFile?: string;
  workRoot?: string;
  webServerUrl?: string | null;
};

export async function generatedSpecPolicyIssues(
  context: RunContext,
  file = context.e2eTestFileExists && context.e2eTestFile ? context.e2eTestFile : context.generatedTestFile,
  options: Omit<SpecPolicyOptions, "fallback"> = {}
) {
  if (!(await existsContained(context.workRoot, file))) {
    return [{ rule: "missing-spec", detail: "Codex did not create the allowed Playwright target." }];
  }
  return inspectGeneratedSpec(await readTextContained(context.workRoot, file), {
    fallback: !context.e2eTestFileExists,
    targetFile: options.targetFile ?? file,
    workRoot: options.workRoot ?? context.workRoot,
    webServerUrl: options.webServerUrl
  });
}

export function inspectGeneratedSpec(source: string, options: SpecPolicyOptions = {}) {
  const issues: SpecPolicyIssue[] = [];
  const file = ts.createSourceFile(options.targetFile ?? "generated.spec.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length) issue(issues, "invalid-syntax", "Generated spec is not valid TypeScript.");
  const bindings = playwrightBindings(file, options.fallback !== false);
  if (options.fallback !== false && !bindings.hasPlaywrightImport) {
    issue(issues, "missing-playwright-import", "Fallback specs must import test and expect from @playwright/test.");
  }

  inspectImports(file, options, issues);
  inspectTopLevel(file, bindings.tests, issues);
  if (options.fallback !== false) inspectFallbackGrammar(file, bindings.tests, bindings.expects, issues);
  let tests = 0;
  let meaningfulAssertions = 0;
  let placeholders = 0;
  let navigates = false;
  walk(file, (node) => {
    if (ts.isCallExpression(node)) {
      const call = callPath(node.expression);
      if (isTestCall(node, call, bindings.tests)) {
        tests += 1;
        const body = testCallback(node);
        if (body) {
          const inspected = inspectTestBody(body, bindings.expects, options.webServerUrl, options.fallback !== false, issues);
          meaningfulAssertions += inspected.meaningfulAssertions;
          placeholders += inspected.placeholders;
          navigates = inspected.navigates || navigates;
        }
      }
      if (call[0] && bindings.tests.has(call[0]) && call.some((part) => part === "skip" || part === "fixme")) {
        issue(issues, "skipped-test", "Generated tests may not be skipped or marked fixme.");
      }
      if (call[0] && bindings.tests.has(call[0]) && call.some((part) => part === "only" || part === "fail")) {
        issue(issues, "test-modifier", "Generated tests may not be focused or marked as expected failures.");
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || isNamedCall(node.expression, ["require", "eval", "Function"])) {
        issue(issues, "unsafe-runtime", "Dynamic loading and runtime code execution are forbidden.");
      }
    }
    if (ts.isNewExpression(node) && isNamedCall(node.expression, ["Function"])) {
      issue(issues, "unsafe-runtime", "Runtime code construction is forbidden.");
    }
    if (ts.isElementAccessExpression(node)
      && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
      && (unsafeRuntimeName(node.argumentExpression.text) || unsafeReflectionName(node.argumentExpression.text))) {
      issue(issues, "unsafe-runtime", "Generated specs may not access runtime capabilities through computed properties.");
    }
    if (ts.isElementAccessExpression(node)
      && node.argumentExpression && !ts.isStringLiteralLike(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)) {
      issue(issues, "unsafe-runtime", "Generated specs may not use dynamic computed property access.");
    }
    if (ts.isPropertyAccessExpression(node) && unsafeReflectionName(node.name.text)) {
      issue(issues, "unsafe-runtime", "Generated specs may not access runtime constructors or module loaders.");
    }
    if (ts.isIdentifier(node) && runtimeReference(node) && unsafeRuntimeName(node.text)) {
      issue(issues, "unsafe-runtime", "Generated specs may not access processes, environment variables, or outbound runtime APIs.");
    }
  });

  if (!tests) issue(issues, "no-tests", "Generated spec must contain at least one Playwright test.");
  if (placeholders) issue(issues, "placeholder-assertion", "Constant placeholder assertions are forbidden.");
  if (!meaningfulAssertions) issue(issues, "no-meaningful-assertion", "Generated spec must make a nonconstant assertion.");
  if (options.fallback !== false && !navigates) {
    issue(issues, "no-app-navigation", "Fallback coverage must navigate through Playwright's page fixture.");
  }
  return issues;
}

export function formatSpecPolicyIssues(issues: SpecPolicyIssue[]) {
  return ["Generated spec policy failed:", ...issues.map(({ rule, detail }) => `- ${rule}: ${detail}`)].join("\n");
}

function inspectImports(file: ts.SourceFile, options: SpecPolicyOptions, issues: SpecPolicyIssue[]) {
  for (const statement of file.statements) {
    const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ? statement.moduleSpecifier
      : ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
        ? statement.moduleReference.expression
        : undefined;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const value = specifier.text;
    if (options.fallback !== false && value !== "@playwright/test") {
      issue(issues, "forbidden-import", `Fallback specs may not import ${value}.`);
    }
    if (value === "@playwright/test" && ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)
        && bindings.elements.some((item) => (item.propertyName?.text ?? item.name.text) === "request")) {
        issue(issues, "unsafe-runtime", "Generated specs may not import Playwright's direct request API.");
      }
    }
    if (forbiddenRuntimeModule(value)) {
      issue(issues, "forbidden-import", `Generated specs may not import ${value}.`);
    }
    if (escapesWorkspace(value, options.targetFile, options.workRoot)) {
      issue(issues, "import-outside-workspace", `Import ${value} resolves outside the isolated workspace.`);
    }
  }
}

function inspectTopLevel(file: ts.SourceFile, testBindings: Set<string>, issues: SpecPolicyIssue[]) {
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause) {
      issue(issues, "top-level-side-effect", "Side-effect-only imports are forbidden.");
      continue;
    }
    if (ts.isExpressionStatement(statement)) {
      if (!ts.isCallExpression(statement.expression) || !testBindings.has(callPath(statement.expression.expression)[0] ?? "")) {
        issue(issues, "top-level-side-effect", "Generated specs may not execute arbitrary top-level code.");
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.declarations.some((item) => item.initializer
        && !isTestExtension(item.initializer, testBindings) && immediateEffect(item.initializer))) {
        issue(issues, "top-level-side-effect", "Generated specs may not execute arbitrary top-level initializers.");
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && immediateEffect(statement.expression)) {
      issue(issues, "top-level-side-effect", "Generated specs may not evaluate exports at module load.");
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.members.some(staticInitializerEffect)) {
      issue(issues, "top-level-side-effect", "Generated specs may not execute class initializers at module load.");
      continue;
    }
    if (!isDeclarativeStatement(statement)) {
      issue(issues, "top-level-side-effect", "Generated specs may not execute arbitrary top-level statements.");
    }
  }
}

function inspectFallbackGrammar(file: ts.SourceFile, tests: Set<string>, expects: Set<string>, issues: SpecPolicyIssue[]) {
  let invalid = false;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.every((declaration) =>
      declaration.initializer && isTestExtension(declaration.initializer, tests)
      && ts.isCallExpression(declaration.initializer) && declaration.initializer.arguments.every(isStaticValue))) continue;
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)
      || callPath(statement.expression.expression).length !== 1
      || !isTestCall(statement.expression, callPath(statement.expression.expression), tests)) {
      invalid = true;
      continue;
    }
    const body = testCallback(statement.expression);
    const name = statement.expression.arguments[0];
    if (statement.expression.arguments.length !== 2 || !body || !name || !ts.isStringLiteralLike(name) || !ts.isBlock(body.body)) {
      invalid = true;
      continue;
    }
    const page = pageBinding(body);
    if (!page || body.body.statements.some((item) => !isFallbackStatement(item, page, expects))) invalid = true;
  }
  if (invalid) issue(issues, "fallback-grammar", "Fallback specs must use only direct page navigation and page-derived Playwright assertions.");
}

function isFallbackStatement(statement: ts.Statement, page: string, expects: Set<string>) {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return false;
  const expression = statement.expression.expression;
  if (!ts.isCallExpression(expression)) return false;
  if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "goto"
    && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === page) {
    return Boolean(expression.arguments[0] && ts.isStringLiteralLike(expression.arguments[0])
      && expression.arguments.length <= 2 && expression.arguments.every(isStaticValue));
  }
  const value = assertionValue(expression, expects);
  return Boolean(value && isPageExpression(value, page) && expression.arguments.every(isStaticValue));
}

function isPageExpression(node: ts.Expression, page: string): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (!pageMethods.has(node.expression.name.text) || !node.arguments.every(isStaticValue)) return false;
  const receiver = node.expression.expression;
  return ts.isIdentifier(receiver) ? receiver.text === page : isPageExpression(receiver, page);
}

function isStaticValue(node: ts.Expression): boolean {
  return ts.isRegularExpressionLiteral(node) || isConstant(node);
}

function inspectNavigation(call: ts.CallExpression, configuredUrl: string | null | undefined, issues: SpecPolicyIssue[]) {
  if (!call.arguments[0] || !ts.isStringLiteralLike(call.arguments[0])) {
    issue(issues, "navigation-target", "Fallback navigation must use a static configured-server URL.");
    return false;
  }
  const target = call.arguments[0].text;
  if (target.startsWith("/") && !target.startsWith("//") && !target.startsWith("/\\")) return true;
  try {
    if (configuredUrl && new URL(target).origin === new URL(configuredUrl).origin) return true;
  } catch {
    // Report the invalid or unrelated target below.
  }
  issue(issues, "navigation-target", "Fallback coverage must use the configured web server URL or its baseURL.");
  return false;
}

function immediateEffect(node: ts.Node): boolean {
  if (ts.isFunctionLike(node) || ts.isClassExpression(node)) return false;
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) return true;
  return node.getChildren().some(immediateEffect);
}

function forbiddenRuntimeModule(value: string) {
  const name = value.replace(/^node:/, "");
  const builtins = ["child_process", "cluster", "dgram", "dns", "dns/promises", "fs", "fs/promises", "http", "http2",
    "https", "module", "net", "tls", "vm", "worker_threads"];
  const clients = ["axios", "got", "node-fetch", "undici", "superagent", "ky", "ws", "cross-fetch"];
  return builtins.includes(name) || clients.some((client) => name === client || name.startsWith(`${client}/`));
}

function unsafeRuntimeName(value: string) {
  return ["process", "require", "module", "Module", "createRequire", "eval", "Function", "Bun", "Deno", "global", "globalThis", "Reflect",
    "fetch", "WebSocket", "XMLHttpRequest", "EventSource", "WebTransport"].includes(value);
}

function unsafeReflectionName(value: string) {
  return ["constructor", "prototype", "__proto__", "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors", "getBuiltinModule", "_load", "__defineGetter__", "__defineSetter__", "__lookupGetter__",
    "__lookupSetter__"].includes(value);
}

function runtimeReference(node: ts.Identifier) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent)
    || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)
    || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)
    || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent)
    || ts.isModuleDeclaration(parent) || ts.isTypeParameterDeclaration(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false;
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)
    || ts.isImportEqualsDeclaration(parent) || ts.isExportSpecifier(parent) || ts.isLabeledStatement(parent)
    || ts.isBreakOrContinueStatement(parent) || ts.isJsxAttribute(parent)) return false;
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return false;
    if (ts.isStatement(current) || ts.isSourceFile(current)) break;
  }
  return true;
}

function escapesWorkspace(specifier: string, targetFile?: string, workRoot?: string) {
  if (!targetFile || !workRoot) return false;
  if (path.isAbsolute(specifier) || path.win32.isAbsolute(specifier) || specifier.startsWith("file:")) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(targetFile), specifier);
  const relative = path.relative(path.resolve(workRoot), resolved);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isTestCall(call: ts.CallExpression, parts: string[], bindings: Set<string>) {
  if (!bindings.has(parts[0] ?? "")) return false;
  const definition = parts.length === 1 || parts.length === 2 && ["only", "skip", "fixme"].includes(parts[1]);
  return definition && call.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
}

function playwrightBindings(file: ts.SourceFile, requirePlaywrightImport: boolean) {
  const tests = new Set(requirePlaywrightImport ? [] : ["test", "it"]);
  const expects = new Set(requirePlaywrightImport ? [] : ["expect"]);
  let hasPlaywrightImport = false;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@playwright/test") continue;
    hasPlaywrightImport = true;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "test") tests.add(element.name.text);
      if (imported === "expect") expects.add(element.name.text);
    }
  }
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && isTestExtension(declaration.initializer, tests)) {
        tests.add(declaration.name.text);
      }
    }
  }
  return { tests, expects, hasPlaywrightImport };
}

function testCallback(call: ts.CallExpression) {
  return call.arguments.find((item): item is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(item) || ts.isFunctionExpression(item));
}

function inspectTestBody(
  body: ts.ArrowFunction | ts.FunctionExpression,
  expects: Set<string>,
  configuredUrl: string | null | undefined,
  fallback: boolean,
  issues: SpecPolicyIssue[]
) {
  const page = pageBinding(body);
  let meaningfulAssertions = 0;
  let placeholders = 0;
  let navigates = false;
  if (fixtureBinding(body, "request")) {
    issue(issues, "unsafe-runtime", "Generated specs may not use Playwright's direct request fixture.");
  }
  if (shadowedBinding(body.body, new Set([...expects, ...(page ? [page] : [])]))) {
    issue(issues, "shadowed-binding", "Fallback specs may not shadow Playwright test bindings.");
    return { meaningfulAssertions, placeholders, navigates };
  }
  walkExecutable(body.body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const assertion = assertionValue(node, expects);
    if (assertion) {
      if (isConstant(assertion)) placeholders += 1;
      else if (!fallback || page && containsIdentifier(assertion, page)) meaningfulAssertions += 1;
    }
    if (page && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "goto"
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === page) {
      navigates = inspectNavigation(node, configuredUrl, issues) || navigates;
    }
  });
  return { meaningfulAssertions, placeholders, navigates };
}

function shadowedBinding(node: ts.Node, protectedNames: Set<string>) {
  let found = false;
  walk(node, (child) => {
    if (ts.isVariableDeclaration(child) || ts.isParameter(child) || ts.isBindingElement(child)) {
      if (bindingNames(child.name).some((name) => protectedNames.has(name))) found = true;
    }
    if ((ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) && child.name && protectedNames.has(child.name.text)) found = true;
    if (ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && ts.isIdentifier(child.left) && protectedNames.has(child.left.text)) found = true;
  });
  return found;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function containsIdentifier(node: ts.Node, name: string) {
  let found = false;
  walk(node, (child) => { if (ts.isIdentifier(child) && child.text === name) found = true; });
  return found;
}

function pageBinding(body: ts.ArrowFunction | ts.FunctionExpression) {
  return fixtureBinding(body, "page");
}

function fixtureBinding(body: ts.ArrowFunction | ts.FunctionExpression, wanted: string) {
  const parameter = body.parameters[0]?.name;
  if (!parameter || !ts.isObjectBindingPattern(parameter)) return null;
  for (const element of parameter.elements) {
    const fixture = element.propertyName && ts.isStringLiteralLike(element.propertyName) ? element.propertyName.text
      : element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text
      : ts.isIdentifier(element.name) ? element.name.text : "";
    if (fixture === wanted && ts.isIdentifier(element.name)) return element.name.text;
  }
  return null;
}

function assertionValue(call: ts.CallExpression, expects: Set<string>) {
  if (!ts.isPropertyAccessExpression(call.expression) || !matchers.has(call.expression.name.text)) return null;
  let receiver: ts.Expression = call.expression.expression;
  while (ts.isPropertyAccessExpression(receiver) && ["not", "resolves", "rejects"].includes(receiver.name.text)) {
    receiver = receiver.expression;
  }
  if (!ts.isCallExpression(receiver)) return null;
  const parts = callPath(receiver.expression);
  if (!expects.has(parts[0] ?? "") || parts.length > 1 && !["soft", "poll"].includes(parts.at(-1) ?? "")) return null;
  return receiver.arguments[0] ?? null;
}

function isTestExtension(node: ts.Expression, bindings: Set<string>) {
  return ts.isCallExpression(node) && callPath(node.expression).at(-1) === "extend"
    && bindings.has(callPath(node.expression)[0] ?? "");
}

function hasStaticModifier(node: ts.Node) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

function staticInitializerEffect(member: ts.ClassElement) {
  if (ts.isClassStaticBlockDeclaration(member)) return true;
  return hasStaticModifier(member) && ts.isPropertyDeclaration(member) && Boolean(member.initializer && immediateEffect(member.initializer));
}

function isDeclarativeStatement(statement: ts.Statement) {
  return ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) || ts.isExportDeclaration(statement)
    || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isFunctionDeclaration(statement)
    || ts.isClassDeclaration(statement) || ts.isModuleDeclaration(statement) || ts.isEmptyStatement(statement);
}

function callPath(expression: ts.Expression): string[] {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) return [...callPath(expression.expression), expression.name.text];
  return [];
}

function isNamedCall(expression: ts.Expression, names: string[]) {
  return ts.isIdentifier(expression) && names.includes(expression.text);
}

function isConstant(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return isConstant(node.expression);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node)) return node.text === "undefined" || node.text === "NaN" || node.text === "Infinity";
  if (ts.isPrefixUnaryExpression(node)) return isConstant(node.operand);
  if (ts.isBinaryExpression(node)) return isConstant(node.left) && isConstant(node.right);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((item) => ts.isExpression(item) && isConstant(item));
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((item) => ts.isPropertyAssignment(item) && isConstant(item.initializer));
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => isConstant(span.expression));
  return ts.isNoSubstitutionTemplateLiteral(node);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function walkExecutable(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => {
    if (!ts.isFunctionLike(child) && !ts.isClassLike(child)) walkExecutable(child, visit);
  });
}

const matchers = new Set([
  "toBe", "toEqual", "toStrictEqual", "toBeCloseTo", "toBeDefined", "toBeFalsy", "toBeGreaterThan",
  "toBeGreaterThanOrEqual", "toBeInstanceOf", "toBeLessThan", "toBeLessThanOrEqual", "toBeNaN", "toBeNull",
  "toBeTruthy", "toBeUndefined", "toContain", "toContainEqual", "toHaveLength", "toHaveProperty", "toMatch",
  "toMatchObject", "toThrow", "toThrowError", "toBeAttached", "toBeChecked", "toBeDisabled", "toBeEditable",
  "toBeEmpty", "toBeEnabled", "toBeFocused", "toBeHidden", "toBeInViewport", "toBeOK", "toBeVisible",
  "toContainText", "toHaveAccessibleDescription", "toHaveAccessibleName", "toHaveAttribute", "toHaveClass",
  "toHaveCount", "toHaveCSS", "toHaveId", "toHaveJSProperty", "toHaveRole", "toHaveScreenshot", "toHaveText",
  "toHaveTitle", "toHaveURL", "toHaveValue", "toHaveValues", "toMatchAriaSnapshot", "toPass", "toMatchSnapshot",
  "toMatchInlineSnapshot", "toThrowErrorMatchingSnapshot", "toThrowErrorMatchingInlineSnapshot"
]);

const pageMethods = new Set([
  "locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle", "getByTestId",
  "first", "last", "nth", "filter", "url", "title", "content", "textContent", "inputValue", "getAttribute", "count",
  "isVisible", "isEnabled", "isDisabled", "isChecked", "isEditable", "isHidden"
]);

function issue(issues: SpecPolicyIssue[], rule: string, detail: string) {
  if (!issues.some((item) => item.rule === rule && item.detail === detail)) issues.push({ rule, detail });
}
