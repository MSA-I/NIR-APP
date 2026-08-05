import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { QA_ROLES, type QaRole } from '../config/roles.ts';
import type { ActionType, ControlType } from './types.ts';

/**
 * Static extraction over the application source.
 *
 * This module reads JSX with the TypeScript parser rather than regular expressions, because the
 * question "which control does this role see" is a question about structure. What it produces is
 * still a hypothesis: a control behind a data-dependent branch, a role check or a dialog that has
 * not been opened is indistinguishable from one that always renders. Every entry it emits is
 * therefore marked `discoveredBy: 'static'` and must be reconciled against the running UI before
 * any coverage claim rests on it. Nothing here is allowed to assert that a control exists.
 */

export interface ExtractedRoute {
  readonly route: string;
  readonly pageComponent: string;
  readonly expectedRoles: readonly QaRole[];
  readonly outsideTenantRoleModel: boolean;
  readonly redirectsTo?: string;
  readonly dynamicParameters: readonly string[];
  readonly sourceFile: string;
}

export interface ExtractedNavItem {
  readonly to: string;
  readonly label: string;
  readonly roles: readonly QaRole[];
  readonly section: string;
}

export interface ExtractedControl {
  readonly localId: string;
  readonly controlType: ControlType;
  readonly actionType: ActionType;
  readonly visibleLabel?: string;
  readonly accessibleName?: string;
  readonly destructive: boolean;
  readonly financial: boolean;
  readonly requiresFixture: boolean;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly tagName: string;
}

export interface ExtractedPageFacts {
  readonly controls: readonly ExtractedControl[];
  readonly queryParameters: readonly string[];
  readonly backendCalls: readonly string[];
  readonly headings: readonly string[];
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isQaRole(value: string): value is QaRole {
  return (QA_ROLES as readonly string[]).includes(value);
}

/** String value of an attribute written as `x="y"` or `x={'y'}`. Anything computed yields undefined. */
function attrString(element: ts.JsxOpeningLikeElement, name: string): string | undefined {
  for (const attr of element.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== name) continue;
    const init = attr.initializer;
    if (!init) return '';
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) {
      const expr = init.expression;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    }
    return undefined;
  }
  return undefined;
}

function hasAttr(element: ts.JsxOpeningLikeElement, name: string): boolean {
  return element.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText() === name);
}

/** Literal role list from `['owner','office']`, or undefined when the expression is computed. */
function roleArray(expr: ts.Expression): QaRole[] | undefined {
  if (!ts.isArrayLiteralExpression(expr)) return undefined;
  const roles: QaRole[] = [];
  for (const element of expr.elements) {
    if (!ts.isStringLiteral(element)) return undefined;
    if (!isQaRole(element.text)) return undefined;
    roles.push(element.text);
  }
  return roles;
}

/** Top-level `const NAME: Role[] = [...]` declarations, so `<Guard roles={STAFF}>` resolves. */
function roleConstants(source: ts.SourceFile): Map<string, QaRole[]> {
  const constants = new Map<string, QaRole[]>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const roles = roleArray(decl.initializer);
      if (roles) constants.set(decl.name.text, roles);
    }
  }
  return constants;
}

/** Inline wrappers a label is allowed to be split across. Anything else ends the descent. */
const INLINE_TAGS = new Set(['span', 'strong', 'em', 'b', 'small', 'i']);

/**
 * The label a control shows, and only that.
 *
 * The descent is depth-limited and stops at non-inline elements on purpose. Walking the whole
 * subtree turns `<Modal>` into a four-hundred-character string containing every label on the
 * screen — which then matches every control at runtime and makes the reconciliation meaningless.
 * A name that long is not a name.
 */
function jsxText(node: ts.Node, depth = 2): string {
  const parts: string[] = [];
  const walk = (child: ts.Node, remaining: number): void => {
    if (ts.isJsxText(child)) {
      const text = child.text.trim();
      if (text) parts.push(text);
      return;
    }
    if (ts.isJsxExpression(child)) {
      // `{busy ? 'שומר…' : 'שמירה'}` is a label; a mapped list of rows is not.
      const scan = (inner: ts.Node): void => {
        if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
          const text = inner.text.trim();
          if (text && !/^[a-z0-9 _:\-/[\]().!]+$/i.test(text)) parts.push(text);
          return;
        }
        if (ts.isConditionalExpression(inner) || ts.isBinaryExpression(inner)) inner.forEachChild(scan);
      };
      if (child.expression) scan(child.expression);
      return;
    }
    if (remaining > 0 && (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child))) {
      const tag = ts.isJsxElement(child) ? child.openingElement.tagName.getText() : child.tagName.getText();
      if (INLINE_TAGS.has(tag)) child.forEachChild((inner) => walk(inner, remaining - 1));
      return;
    }
  };
  node.forEachChild((child) => walk(child, depth));
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

const DESTRUCTIVE = /מחיק|מחק|ביטול|בטל|הסר|דחיי|דחה|שלילה|איפוס|השבת/;
const FINANCIAL = /תשלום|תשלומים|סכום|חשבונית|חשבוניות|זיכוי|העברה|כספ|לתשלום|אשראי|בנק|מחיר|הוצא/;
const FIXTURE_HINT = /קובץ|העלא|ייבוא|יבוא|טעינ|סריק|צילום/;

/** Hebrew UI verbs are the only reliable signal of intent available without running the app. */
function actionTypeFor(name: string, tag: string, type: ControlType): ActionType {
  if (type === 'link') return 'navigation';
  if (type === 'search') return 'search';
  if (type === 'filter') return 'filter';
  if (type === 'pagination') return 'navigation';
  if (type === 'file_upload') return 'upload';
  // ActionType has no 'print': printing produces a document, which is the export contract.
  if (type === 'print' || type === 'download') return 'export';
  if (/ייצוא|יצוא|הורד|Excel|CSV|PDF/i.test(name)) return 'export';
  if (/ייבוא|יבוא|קליט/.test(name)) return 'import';
  if (/העלא/.test(name)) return 'upload';
  if (/אישור|אשר|מאושר|approve/i.test(name)) return 'approve';
  if (/דחיי|דחה|reject/i.test(name)) return 'reject';
  if (/מחיק|מחק|הסר/.test(name)) return 'delete';
  if (/חדש|חדשה|הוספ|הוסף|יצירת|צור|הגשת/.test(name)) return 'create';
  if (/שמיר|שמור|עדכון|עדכן|שינוי|עריכ|ערוך/.test(name)) return 'update';
  if (/חיפוש/.test(name)) return 'search';
  if (/סינון|סנן|מסנן/.test(name)) return 'filter';
  if (/רענון|רענן|טעינ|הצג|פתיחת|פתח|סגירת|סגור/.test(name)) return 'state_change';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'update';
  if (type === 'button') return 'state_change';
  return 'none';
}

function controlTypeFor(tag: string, element: ts.JsxOpeningLikeElement, name: string): ControlType | null {
  const inputType = attrString(element, 'type');
  switch (tag) {
    case 'button':
      if (/הדפס/.test(name)) return 'print';
      if (/ייצוא|יצוא|הורד/.test(name)) return 'download';
      return 'button';
    case 'a':
      return hasAttr(element, 'download') ? 'download' : 'link';
    case 'Link':
    case 'NavLink':
      return 'link';
    case 'textarea':
      return 'textarea';
    case 'select':
      return /סינון|מסנן|סנן|תצוגה/.test(name) ? 'filter' : 'select';
    case 'input':
      if (inputType === 'file') return 'file_upload';
      if (inputType === 'checkbox') return 'checkbox';
      if (inputType === 'radio') return 'radio';
      if (inputType === 'search' || /חיפוש/.test(name)) return 'search';
      if (/סינון|מסנן|סנן/.test(name)) return 'filter';
      return 'input';
    case 'FileUpload':
    case 'QuickCapture':
      return 'file_upload';
    case 'ActionMenu':
      return 'menu';
    case 'Modal':
    case 'ConfirmDialog':
      return 'dialog';
    case 'DataTable':
      return 'table_action';
    case 'KpiCard':
    case 'TaskLine':
      return 'link';
    default:
      return null;
  }
}

/**
 * Controls declared in one component file. Elements without any resolvable name are still
 * emitted, because an unnamed control is itself a finding the runtime pass must confirm.
 */
export function extractControls(file: string, repoRoot: string): ExtractedPageFacts {
  const source = parse(file);
  const relative = path.relative(repoRoot, file).replace(/\\/g, '/');
  const controls: ExtractedControl[] = [];
  const queryParameters = new Set<string>();
  const backendCalls = new Set<string>();
  const headings = new Set<string>();
  const seen = new Set<string>();

  // `<label htmlFor="x">שם הספק *</label><input id="x" />` is how every field in this codebase is
  // named. Resolving it statically is the same lookup the browser performs, so the manifest and the
  // runtime snapshot end up agreeing on the field's name instead of the manifest calling it unnamed.
  const labelFor = new Map<string, string>();
  const collectLabels = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText() === 'label') {
      const target = attrString(node, 'htmlFor');
      const parent = node.parent;
      if (target && ts.isJsxElement(parent)) {
        const text = jsxText(parent);
        if (text) labelFor.set(target, text);
      }
    }
    node.forEachChild(collectLabels);
  };
  collectLabels(source);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg0 = node.arguments[0];
      const literal = arg0 && ts.isStringLiteral(arg0) ? arg0.text : undefined;
      if (ts.isPropertyAccessExpression(callee) && literal) {
        const method = callee.name.text;
        if (method === 'rpc') backendCalls.add(`rpc:${literal}`);
        else if (method === 'from') backendCalls.add(`table:${literal}`);
        else if (method === 'invoke') backendCalls.add(`edge:${literal}`);
        else if (method === 'get' && /searchParams|params/i.test(callee.expression.getText())) {
          queryParameters.add(literal);
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'useParamState' && literal) queryParameters.add(literal);
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      const parent = node.parent;
      // Only intrinsic elements own their text. A composed component (`Modal`, `DataTable`)
      // wraps other people's labels, so its name has to come from a prop or not at all.
      const intrinsic = /^[a-z]/.test(tag);
      const text = intrinsic && ts.isJsxElement(parent) ? jsxText(parent) : '';
      if (/^h[1-6]$/.test(tag) && text) headings.add(text);

      const ariaLabel = attrString(node, 'aria-label');
      const placeholder = attrString(node, 'placeholder');
      const title = attrString(node, 'title');
      const label = attrString(node, 'label');
      const searchLabel = attrString(node, 'searchLabel');
      // Empty string is a real answer from attrString ("aria-label" with no value), so `??`
      // would keep it and hide the next candidate. Take the first non-empty instead.
      const elementId = attrString(node, 'id');
      const labelledBy = elementId ? labelFor.get(elementId) : undefined;
      const accessibleName = [ariaLabel, label, searchLabel, labelledBy, text, placeholder, title].find(
        (candidate) => typeof candidate === 'string' && candidate.trim() !== '',
      );
      const name = accessibleName ?? '';

      const controlType = controlTypeFor(tag, node, name);
      if (controlType) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const key = `${tag}|${name}|${controlType}`;
        // The same control rendered in two branches is one control, not two.
        if (!seen.has(key)) {
          seen.add(key);
          controls.push({
            localId: slug(`${tag}-${name || `line-${line}`}`),
            controlType,
            actionType: actionTypeFor(name, tag, controlType),
            visibleLabel: text || undefined,
            accessibleName: accessibleName || undefined,
            destructive: DESTRUCTIVE.test(name),
            financial: FINANCIAL.test(name),
            requiresFixture: controlType === 'file_upload' || FIXTURE_HINT.test(name),
            sourceFile: relative,
            sourceLine: line,
            tagName: tag,
          });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  return {
    controls,
    queryParameters: [...queryParameters].sort(),
    backendCalls: [...backendCalls].sort(),
    headings: [...headings],
  };
}

export function slug(value: string): string {
  const normalized = value
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'control';
}

/** `<Route path element>` entries from App.tsx, with guard roles resolved. */
export function extractRoutes(appFile: string, repoRoot: string): ExtractedRoute[] {
  const source = parse(appFile);
  const constants = roleConstants(source);
  const relative = path.relative(repoRoot, appFile).replace(/\\/g, '/');
  const routes: ExtractedRoute[] = [];

  const guardRoles = (element: ts.JsxOpeningLikeElement): QaRole[] | undefined => {
    for (const attr of element.attributes.properties) {
      if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'roles') continue;
      const init = attr.initializer;
      if (!init || !ts.isJsxExpression(init) || !init.expression) return undefined;
      const expr = init.expression;
      if (ts.isIdentifier(expr)) return constants.get(expr.text);
      return roleArray(expr);
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (node.tagName.getText() === 'Route') {
        const routePath = attrString(node, 'path');
        if (routePath && routePath !== '*') {
          let pageComponent = 'unknown';
          let roles: QaRole[] | undefined;
          let outside = false;
          let redirectsTo: string | undefined;
          let sawNavigate = false;

          const elementAttr = node.attributes.properties.find(
            (attr): attr is ts.JsxAttribute => ts.isJsxAttribute(attr) && attr.name.getText() === 'element',
          );
          const initializer = elementAttr?.initializer;
          if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
            const scan = (child: ts.Node): void => {
              if (ts.isJsxSelfClosingElement(child) || ts.isJsxOpeningElement(child)) {
                const tag = child.tagName.getText();
                if (tag === 'Guard') roles = guardRoles(child);
                else if (tag === 'PlatformGuard') outside = true;
                else if (tag === 'Navigate') {
                  sawNavigate = true;
                  // `to={homeFor(profile?.role)}` has no literal target; say so instead of
                  // leaving the field blank, which reads as "no redirect happens".
                  redirectsTo = attrString(child, 'to') ?? redirectsTo ?? '(computed at runtime)';
                }
                else if (/^[A-Z]/.test(tag) && !['Guard', 'PlatformGuard', 'Navigate', 'PageLoader'].includes(tag)) {
                  if (pageComponent === 'unknown') pageComponent = tag;
                }
              }
              child.forEachChild(scan);
            };
            scan(initializer.expression);
          }

          const dynamicParameters = [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
          // A route with neither a guard nor a page is a public screen (login, accept-invite).
          // An unguarded redirect is reachable by everyone; what it renders is the target's problem.
          const reachableByAll = !roles && !outside;
          routes.push({
            route: routePath,
            pageComponent: pageComponent === 'unknown' && sawNavigate ? 'Navigate' : pageComponent,
            expectedRoles: roles ?? (reachableByAll ? [...QA_ROLES] : []),
            outsideTenantRoleModel: outside,
            redirectsTo,
            dynamicParameters,
            sourceFile: relative,
          });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  // App.tsx declares /admin twice: once in the platform-only shell for an operator with no tenant
  // profile, and once in the main tree. That is one route with one guard, and emitting it twice
  // would inflate every total and give the matrix two contradictory rows for the same path.
  const merged = new Map<string, ExtractedRoute>();
  for (const route of routes) {
    const existing = merged.get(route.route);
    if (!existing) {
      merged.set(route.route, route);
      continue;
    }
    merged.set(route.route, {
      ...existing,
      pageComponent: existing.pageComponent === 'unknown' ? route.pageComponent : existing.pageComponent,
      expectedRoles: existing.expectedRoles.length ? existing.expectedRoles : route.expectedRoles,
      outsideTenantRoleModel: existing.outsideTenantRoleModel || route.outsideTenantRoleModel,
      redirectsTo: existing.redirectsTo ?? route.redirectsTo,
    });
  }
  return [...merged.values()];
}

/**
 * Component name to source file, read from both the `lazy(() => import('./pages/X'))` map and
 * the eager imports at the top of App.tsx. Without this the manifest could name a page component
 * but not point at the file whose controls belong to the route.
 */
export function extractComponentSources(appFile: string, repoRoot: string): Map<string, string[]> {
  const source = parse(appFile);
  const directory = path.dirname(appFile);
  const sources = new Map<string, string[]>();

  const resolve = (specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const base = path.resolve(directory, specifier);
    for (const candidate of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
      try {
        readFileSync(candidate);
        return path.relative(repoRoot, candidate).replace(/\\/g, '/');
      } catch {
        continue;
      }
    }
    return undefined;
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const file = resolve(statement.moduleSpecifier.text);
      const name = statement.importClause?.name?.text;
      if (file && name) sources.set(name, [file]);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      let specifier: string | undefined;
      const scan = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) specifier = arg.text;
        }
        node.forEachChild(scan);
      };
      scan(decl.initializer);
      const file = specifier ? resolve(specifier) : undefined;
      if (file) sources.set(decl.name.text, [file]);
    }
  }

  // A route element can point at a component declared inside App.tsx itself — DashboardHome is
  // the important one, because it is how every role reaches its home screen. Skipping it would
  // leave the most-used route in the product with zero discovered controls, which reads in a
  // coverage report as "nothing to test" rather than "the extractor could not follow it".
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    const rendered = new Set<string>();
    const scan = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName.getText();
        if (/^[A-Z]/.test(tag)) rendered.add(tag);
      }
      node.forEachChild(scan);
    };
    scan(statement.body);
    const files = [...rendered].flatMap((tag) => sources.get(tag) ?? []);
    if (files.length) sources.set(statement.name.text, [...new Set(files)]);
  }

  return sources;
}

/** Local component files a page pulls in, so a dialog defined next door is not lost. */
export function resolveLocalImports(file: string, repoRoot: string, depth = 1): string[] {
  const collected = new Set<string>();
  const walk = (current: string, remaining: number): void => {
    if (remaining < 0) return;
    let source: ts.SourceFile;
    try {
      source = parse(current);
    } catch {
      return;
    }
    const directory = path.dirname(current);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;
      const base = path.resolve(directory, specifier);
      const candidates = [`${base}.tsx`, path.join(base, 'index.tsx')];
      for (const candidate of candidates) {
        try {
          readFileSync(candidate);
        } catch {
          continue;
        }
        const relative = path.relative(repoRoot, candidate).replace(/\\/g, '/');
        if (collected.has(relative)) break;
        collected.add(relative);
        walk(candidate, remaining - 1);
        break;
      }
    }
  };
  walk(file, depth);
  return [...collected];
}

/** `NAV` in Layout.tsx: the only place that decides what a role can see without typing a URL. */
export function extractNavigation(layoutFile: string): ExtractedNavItem[] {
  const source = parse(layoutFile);
  const items: ExtractedNavItem[] = [];

  const readItem = (object: ts.ObjectLiteralExpression, section: string): void => {
    let to: string | undefined;
    let label: string | undefined;
    let roles: QaRole[] | undefined;
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = property.name.getText();
      const value = property.initializer;
      if (key === 'to' && ts.isStringLiteral(value)) to = value.text;
      else if (key === 'label' && ts.isStringLiteral(value)) label = value.text;
      else if (key === 'roles') roles = roleArray(value) ?? [];
    }
    if (to && label) items.push({ to, label, roles: roles ?? [], section });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'NAV' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const group of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(group)) continue;
        let section = '';
        let groupItems: ts.ArrayLiteralExpression | undefined;
        for (const property of group.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = property.name.getText();
          if (key === 'section' && ts.isStringLiteral(property.initializer)) section = property.initializer.text;
          if (key === 'items' && ts.isArrayLiteralExpression(property.initializer)) groupItems = property.initializer;
        }
        for (const item of groupItems?.elements ?? []) {
          if (ts.isObjectLiteralExpression(item)) readItem(item, section);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  return items;
}
