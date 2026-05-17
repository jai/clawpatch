import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
import {
  dependencyFieldHas,
  packageRelativePath,
  projectContextFiles,
  projectTags,
  projectTargetCommand,
} from "./projects.js";
import { normalize, pathMatchesPrefix, shouldSkip, walk } from "./shared.js";
import type { NodeProjectInfo } from "./projects.js";
import type { WorkspaceTaskGraph } from "./task-graph.js";
import { FeatureSeed, MapperContext, SeedFileRef, SeedTestRef } from "./types.js";

type AngularPackage = {
  project: NodeProjectInfo;
  tags: string[];
  testCommand: string | null | undefined;
  contextFiles: SeedFileRef[];
};

type ImportMap = Map<string, string>;

type RouteRecord = {
  path: string;
  entryPath: string;
  symbol: string | null;
  declarationPath: string;
  lazyPath: string | null;
  guards: string[];
  resolvers: string[];
  dataKeys: string[];
};

const angularDeps = [
  "@angular/core",
  "@angular/router",
  "@angular/cli",
  "@ionic/angular",
  "@capacitor/core",
  "@angular/fire",
  "firebase",
  "firebase-admin",
];
const angularConfigFiles = [
  "angular.json",
  "ionic.config.json",
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.json",
  "firebase.json",
  ".firebaserc",
];
const routeFilePattern =
  /(^|\/)(app\.routes|[^/]+\.routes|app-routing\.module|[^/]+-routing\.module)\.ts$/u;

export async function angularSeeds(root: string, context: MapperContext): Promise<FeatureSeed[]> {
  const packages = await discoverAngularPackages(root, context.projects, context.taskGraph);
  const seedGroups = await Promise.all(packages.map((info) => angularProjectSeeds(root, info)));
  return mergeSeeds(seedGroups.flat());
}

async function discoverAngularPackages(
  root: string,
  projects: NodeProjectInfo[],
  taskGraph: WorkspaceTaskGraph,
): Promise<AngularPackage[]> {
  const packages: AngularPackage[] = [];
  for (const project of projects) {
    const tags = await angularTags(root, project);
    if (tags.length === 0) {
      continue;
    }
    packages.push({
      project,
      tags,
      testCommand: projectTargetCommand(project, "test", taskGraph),
      contextFiles: await projectContextFiles(root, project),
    });
  }
  return packages;
}

async function angularTags(root: string, project: NodeProjectInfo): Promise<string[]> {
  const tags = new Set<string>();
  const pkg = project.packageJson;
  for (const dep of angularDeps) {
    if (
      dependencyFieldHas(pkg?.dependencies, dep) ||
      dependencyFieldHas(pkg?.devDependencies, dep)
    ) {
      tags.add(tagForDependency(dep));
    }
  }
  for (const file of angularConfigFiles) {
    if (await pathExists(join(root, packageRelativePath(project.root, file)))) {
      tags.add(tagForConfig(file));
    }
  }
  for (const source of ["src/app", "app.routes.ts", "app-routing.module.ts"]) {
    if (await pathExists(join(root, packageRelativePath(project.root, source)))) {
      tags.add("angular");
    }
  }
  return [...tags];
}

async function angularProjectSeeds(root: string, info: AngularPackage): Promise<FeatureSeed[]> {
  const prefixes = await sourcePrefixes(root, info.project);
  const files = await walk(root, prefixes);
  const sourceFiles = files.filter((file) => isAngularSource(file));
  const tests = sourceFiles.filter(isJsTestPath);
  const routedEntries = new Set<string>();
  const seeds: FeatureSeed[] = [];

  for (const seed of await routeSeeds(root, info, sourceFiles, tests)) {
    routedEntries.add(seed.entryPath);
    seeds.push(seed);
  }
  seeds.push(...componentSeeds(info, sourceFiles, tests, routedEntries));
  seeds.push(...roleSeeds(info, sourceFiles, tests));
  seeds.push(...(await configSeeds(root, info)));

  return seeds;
}

async function sourcePrefixes(root: string, project: NodeProjectInfo): Promise<string[]> {
  const prefixes = new Set<string>();
  if (project.sourceRoot !== null) {
    prefixes.add(project.sourceRoot);
  }
  for (const sourceRoot of await angularJsonSourceRoots(root, project)) {
    prefixes.add(sourceRoot);
  }
  for (const fallback of ["src", "src/app", "app"]) {
    prefixes.add(packageRelativePath(project.root, fallback));
  }
  return [...prefixes].filter((prefix) => !shouldSkip(prefix));
}

async function angularJsonSourceRoots(root: string, project: NodeProjectInfo): Promise<string[]> {
  const path = packageRelativePath(project.root, "angular.json");
  if (!(await pathExists(join(root, path)))) {
    return [];
  }
  const parsed: unknown = JSON.parse(await readFile(join(root, path), "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const projects = (parsed as { projects?: unknown }).projects;
  if (typeof projects !== "object" || projects === null) {
    return [];
  }
  return Object.values(projects).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const sourceRoot = (entry as { sourceRoot?: unknown }).sourceRoot;
    return typeof sourceRoot === "string" ? [packageRelativePath(project.root, sourceRoot)] : [];
  });
}

async function routeSeeds(
  root: string,
  info: AngularPackage,
  files: string[],
  tests: string[],
): Promise<FeatureSeed[]> {
  const routeFiles = files.filter(isRouteFileCandidate);
  const seeds: FeatureSeed[] = [];
  for (const file of routeFiles) {
    const source = await readFile(join(root, file), "utf8");
    const imports = importMap(file, source, new Set(files));
    for (const route of routesFromSource(file, source, imports, new Set(files))) {
      const routeTests = associatedTests([route.entryPath], tests, info.testCommand ?? null);
      const ownedFiles = uniqueFileRefs([
        { path: route.entryPath, reason: "route entrypoint" },
        ...companionRefs(route.entryPath, files, "route companion"),
        { path: route.declarationPath, reason: "route declaration" },
        ...(route.lazyPath === null ? [] : [{ path: route.lazyPath, reason: "lazy route target" }]),
      ]);
      seeds.push({
        title: `Angular route ${route.path}`,
        summary: `Angular/Ionic route '${route.path}' declared in ${route.declarationPath}.`,
        kind: "route",
        source: "angular-route",
        confidence: route.symbol === null ? "medium" : "high",
        entryPath: route.entryPath,
        identityKey: `angular:route:${info.project.root}:${route.path}:${route.entryPath}`,
        symbol: route.symbol,
        route: route.path,
        command: null,
        ownedFiles,
        contextFiles: uniqueFileRefs([
          ...info.contextFiles,
          ...route.guards.map((guard) => ({
            path: route.declarationPath,
            reason: `guard ${guard}`,
          })),
          ...route.resolvers.map((resolver) => ({
            path: route.declarationPath,
            reason: `resolver ${resolver}`,
          })),
          ...route.dataKeys.map((key) => ({
            path: route.declarationPath,
            reason: `route data ${key}`,
          })),
          ...routeTests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests: routeTests,
        tags: ["angular", ...info.tags, ...projectTags(info.project)],
        trustBoundaries: ["user-input", "network", "auth", "serialization"],
        skipNearbyTests: true,
      });
    }
  }
  return seeds;
}

function routesFromSource(
  file: string,
  source: string,
  imports: ImportMap,
  fileSet: Set<string>,
): RouteRecord[] {
  const routeArrays = namedRouteArrays(source);
  const arrays = [...routeArrays.values(), ...inlineRouteArrays(source, routeArrays)];
  return arrays.flatMap((array) => routeRecords(file, array, imports, fileSet, ""));
}

function routeRecords(
  file: string,
  arraySource: string,
  imports: ImportMap,
  fileSet: Set<string>,
  parentPath: string,
): RouteRecord[] {
  const records: RouteRecord[] = [];
  for (const objectSource of topLevelObjects(arraySource)) {
    const path = composeRoute(parentPath, topLevelStringProp(objectSource, "path") ?? "");
    const component = topLevelIdentifierProp(objectSource, "component");
    const loadChildren = dynamicImportPath(topLevelPropSource(objectSource, "loadChildren"));
    const loadComponent = dynamicImportPath(topLevelPropSource(objectSource, "loadComponent"));
    const lazyPath = resolveImport(file, loadComponent ?? loadChildren, fileSet);
    const entryPath =
      (component === null ? null : imports.get(component)) ??
      lazyPath ??
      componentFallback(file, component, fileSet);
    if (entryPath !== null) {
      records.push({
        path,
        entryPath,
        symbol: component,
        declarationPath: file,
        lazyPath,
        guards: guardNames(objectSource),
        resolvers: resolverNames(objectSource),
        dataKeys: objectKeys(topLevelPropSource(objectSource, "data")),
      });
    }
    const children = topLevelArrayProp(objectSource, "children");
    if (children !== null) {
      records.push(...routeRecords(file, children, imports, fileSet, path));
    }
  }
  return records;
}

function componentSeeds(
  info: AngularPackage,
  files: string[],
  tests: string[],
  routedEntries: Set<string>,
): FeatureSeed[] {
  return files
    .filter((file) => /\.(page|component)\.ts$/u.test(file))
    .filter((file) => !isJsTestPath(file) && !routedEntries.has(file))
    .filter((file) => /(?:@Component|modal|popup|sheet|dialog|drawer|tab|page)/iu.test(file))
    .map((file) => {
      const componentTests = associatedTests([file], tests, info.testCommand ?? null);
      return {
        title: `Angular component ${displayName(file)}`,
        summary: `Angular/Ionic component implemented by ${file}.`,
        kind: "ui-flow",
        source: file.endsWith(".page.ts") ? "angular-page-component" : "angular-component",
        confidence: "medium",
        entryPath: file,
        identityKey: `angular:component:${info.project.root}:${file}`,
        symbol: symbolName(file),
        route: null,
        command: null,
        ownedFiles: uniqueFileRefs([
          { path: file, reason: "component entrypoint" },
          ...companionRefs(file, files, "component companion"),
        ]),
        contextFiles: uniqueFileRefs([
          ...info.contextFiles,
          ...sameDirServices(file, files),
          ...componentTests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests: componentTests,
        tags: ["angular", ...info.tags, ...projectTags(info.project)],
        trustBoundaries: ["user-input", "network", "serialization"],
        skipNearbyTests: true,
      };
    });
}

function roleSeeds(info: AngularPackage, files: string[], tests: string[]): FeatureSeed[] {
  return files.flatMap((file) => {
    const role = angularRole(file);
    if (role === null) {
      return [];
    }
    const seedTests = associatedTests([file], tests, info.testCommand ?? null);
    return [
      {
        title: `Angular ${role.label} ${displayName(file)}`,
        summary: `Angular ${role.label} implemented by ${file}.`,
        kind: role.kind,
        source: `angular-${role.source}`,
        confidence: "medium",
        entryPath: file,
        identityKey: `angular:${role.source}:${info.project.root}:${file}`,
        symbol: symbolName(file),
        route: null,
        command: null,
        ownedFiles: uniqueFileRefs([
          { path: file, reason: `${role.label} entrypoint` },
          ...companionRefs(file, files, `${role.label} companion`),
        ]),
        contextFiles: uniqueFileRefs([
          ...info.contextFiles,
          ...seedTests.map((test) => ({ path: test.path, reason: "associated test" })),
        ]),
        tests: seedTests,
        tags: ["angular", role.source, ...info.tags, ...projectTags(info.project)],
        trustBoundaries: role.trustBoundaries,
        skipNearbyTests: true,
      } satisfies FeatureSeed,
    ];
  });
}

async function configSeeds(root: string, info: AngularPackage): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  for (const config of angularConfigFiles) {
    const path = packageRelativePath(info.project.root, config);
    if (!(await pathExists(join(root, path)))) {
      continue;
    }
    seeds.push({
      title: `Angular config ${config}`,
      summary: `Angular/Ionic project configuration in ${path}.`,
      kind: "config",
      source: "angular-config",
      confidence: "high",
      entryPath: path,
      identityKey: `angular:config:${info.project.root}:${path}`,
      symbol: null,
      route: null,
      command: null,
      tags: ["angular", tagForConfig(config), ...info.tags, ...projectTags(info.project)],
      trustBoundaries: ["filesystem", "process-exec", "secrets"],
      skipNearbyTests: true,
    });
  }
  return seeds;
}

function namedRouteArrays(source: string): Map<string, string> {
  const arrays = new Map<string, string>();
  const pattern = /(?:export\s+)?const\s+([A-Za-z0-9_]+)(?:\s*:\s*[^=]+)?\s*=/gu;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const start = skipWhitespace(source, match.index + match[0].length);
    if (name !== undefined && source[start] === "[") {
      arrays.set(name, readBalanced(source, start, "[", "]") ?? "");
    }
  }
  return arrays;
}

function inlineRouteArrays(source: string, namedArrays: Map<string, string>): string[] {
  const arrays: string[] = [];
  const pattern = /(?:RouterModule\.for(?:Root|Child)|provideRouter)\s*\(/gu;
  for (const match of source.matchAll(pattern)) {
    const start = skipWhitespace(source, match.index + match[0].length);
    if (source[start] === "[") {
      const array = readBalanced(source, start, "[", "]");
      if (array !== null) {
        arrays.push(array);
      }
    } else {
      const name = /^[A-Za-z0-9_]+/u.exec(source.slice(start))?.[0];
      const array = name === undefined ? undefined : namedArrays.get(name);
      if (array !== undefined) {
        arrays.push(array);
      }
    }
  }
  return arrays;
}

function topLevelObjects(arraySource: string): string[] {
  const objects: string[] = [];
  for (let index = 0; index < arraySource.length; index += 1) {
    if (arraySource[index] !== "{") {
      continue;
    }
    const object = readBalanced(arraySource, index, "{", "}");
    if (object !== null) {
      objects.push(object);
      index += object.length - 1;
    }
  }
  return objects;
}

function topLevelStringProp(source: string, name: string): string | null {
  const value = topLevelPropSource(source, name);
  const match = /^["'`]([^"'`]*)["'`]$/u.exec(value?.trim() ?? "");
  return match?.[1] ?? null;
}

function topLevelIdentifierProp(source: string, name: string): string | null {
  const value = topLevelPropSource(source, name)?.trim();
  return value === undefined ? null : (/^[A-Za-z0-9_]+$/u.exec(value)?.[0] ?? null);
}

function topLevelArrayProp(source: string, name: string): string | null {
  const value = topLevelPropSource(source, name)?.trim();
  return value?.startsWith("[") === true ? value : null;
}

function topLevelPropSource(source: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*:`, "gu");
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    if (!isTopLevel(source, match.index)) {
      continue;
    }
    return readValue(source, skipWhitespace(source, start));
  }
  return null;
}

function readValue(source: string, start: number): string | null {
  const char = source[start];
  if (char === "{" || char === "[") {
    return readBalanced(source, start, char, char === "{" ? "}" : "]");
  }
  if (char === "'" || char === '"' || char === "`") {
    const end = readStringEnd(source, start, char);
    return end === -1 ? null : source.slice(start, end + 1);
  }
  let end = start;
  while (end < source.length && ![",", "\n", "}"].includes(source[end] ?? "")) {
    end += 1;
  }
  return source.slice(start, end).trim();
}

function isTopLevel(source: string, index: number): boolean {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = source[cursor];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  return depth === 1;
}

function readBalanced(source: string, start: number, open: string, close: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return null;
}

function readStringEnd(source: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return index;
    }
  }
  return -1;
}

function importMap(fromFile: string, source: string, fileSet: Set<string>): ImportMap {
  const imports: ImportMap = new Map();
  for (const match of source.matchAll(/import\s+([A-Za-z0-9_]+)\s+from\s+["']([^"']+)["']/gu)) {
    addImport(imports, fromFile, match[1], match[2], fileSet);
  }
  for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/gu)) {
    for (const part of (match[1] ?? "").split(",")) {
      const [imported, alias] = part.trim().split(/\s+as\s+/u);
      addImport(imports, fromFile, alias ?? imported, match[2], fileSet);
    }
  }
  return imports;
}

function addImport(
  imports: ImportMap,
  fromFile: string,
  symbol: string | undefined,
  importPath: string | undefined,
  fileSet: Set<string>,
): void {
  if (symbol === undefined || importPath === undefined) {
    return;
  }
  const resolved = resolveImport(fromFile, importPath, fileSet);
  if (resolved !== null) {
    imports.set(symbol.trim(), resolved);
  }
}

function resolveImport(
  fromFile: string,
  importPath: string | null,
  fileSet: Set<string>,
): string | null {
  if (importPath === null || !importPath.startsWith(".")) {
    return null;
  }
  const base = normalize(join(dirname(fromFile), importPath));
  for (const candidate of [
    `${base}.ts`,
    `${base}.page.ts`,
    `${base}.component.ts`,
    `${base}.module.ts`,
    `${base}.routes.ts`,
    `${base}/index.ts`,
  ]) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function dynamicImportPath(source: string | null): string | null {
  return /import\(\s*["']([^"']+)["']\s*\)/u.exec(source ?? "")?.[1] ?? null;
}

function guardNames(source: string): string[] {
  return ["canActivate", "canActivateChild", "canMatch", "canLoad", "canDeactivate"].flatMap(
    (name) => objectKeys(topLevelPropSource(source, name)),
  );
}

function resolverNames(source: string): string[] {
  return objectKeys(topLevelPropSource(source, "resolve"));
}

function objectKeys(source: string | null): string[] {
  if (source === null) {
    return [];
  }
  if (source.trim().startsWith("[")) {
    return [...source.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/gu)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
  }
  return [...source.matchAll(/([A-Za-z0-9_]+)\s*[:,]/gu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function composeRoute(parent: string, child: string): string {
  if (child === "**") {
    return parent === "" || parent === "/" ? "/*" : `${parent}/*`;
  }
  if (child.startsWith("/")) {
    return normalizeRoute(child);
  }
  const segments = [parent, child].filter((segment) => segment.length > 0 && segment !== "/");
  return normalizeRoute(`/${segments.join("/")}`);
}

function normalizeRoute(route: string): string {
  const normalized = route.replace(/\/+/gu, "/").replace(/\/$/u, "");
  return normalized.length === 0 ? "/" : normalized;
}

function componentFallback(
  routeFile: string,
  component: string | null,
  fileSet: Set<string>,
): string | null {
  if (component === null) {
    return null;
  }
  const expected = kebab(component.replace(/(?:Page|Component)$/u, ""));
  const dir = dirname(routeFile);
  return (
    [...fileSet].find(
      (file) =>
        pathMatchesPrefix(file, dir) &&
        /\.(page|component)\.ts$/u.test(file) &&
        basename(file).includes(expected),
    ) ?? null
  );
}

function companionRefs(file: string, files: string[], reason: string): SeedFileRef[] {
  const fileSet = new Set(files);
  const base = file.replace(
    /\.(page|component|service|guard|resolver|directive|pipe|module)\.ts$/u,
    "",
  );
  const typedBase = file.replace(/\.ts$/u, "");
  const candidates = [
    `${typedBase}.html`,
    `${typedBase}.scss`,
    `${typedBase}.sass`,
    `${typedBase}.css`,
    `${typedBase}.less`,
    `${typedBase}.spec.ts`,
    `${base}.html`,
    `${base}.scss`,
    `${base}.sass`,
    `${base}.css`,
    `${base}.less`,
    `${base}.spec.ts`,
    `${base}.module.ts`,
    `${base}-routing.module.ts`,
    `${base}.routes.ts`,
    `${base}.model.ts`,
    `${base}.models.ts`,
    `${base}.types.ts`,
    `${base}.const.ts`,
    `${base}.consts.ts`,
    `${base}.constants.ts`,
    `${base}.service.ts`,
    `${base}.service.spec.ts`,
  ];
  return candidates.filter((candidate) => fileSet.has(candidate)).map((path) => ({ path, reason }));
}

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const companions = new Set(
    files.flatMap((file) => companionRefs(file, tests, "test").map((ref) => ref.path)),
  );
  return [...companions].map((path) => ({ path, command }));
}

function sameDirServices(file: string, files: string[]): SeedFileRef[] {
  const dir = dirname(file);
  return files
    .filter((candidate) => pathMatchesPrefix(candidate, dir) && candidate.endsWith(".service.ts"))
    .map((path) => ({ path, reason: "same feature service" }));
}

function angularRole(file: string): {
  source: string;
  label: string;
  kind: FeatureSeed["kind"];
  trustBoundaries: FeatureSeed["trustBoundaries"];
} | null {
  if (file.endsWith(".service.ts")) {
    return {
      source: "service",
      label: "service",
      kind: "service",
      trustBoundaries: ["network", "serialization"],
    };
  }
  if (file.endsWith(".guard.ts")) {
    return {
      source: "guard",
      label: "guard",
      kind: "service",
      trustBoundaries: ["auth", "permissions"],
    };
  }
  if (file.endsWith(".resolver.ts")) {
    return {
      source: "resolver",
      label: "resolver",
      kind: "service",
      trustBoundaries: ["network", "serialization"],
    };
  }
  if (file.endsWith(".directive.ts")) {
    return {
      source: "directive",
      label: "directive",
      kind: "ui-flow",
      trustBoundaries: ["user-input"],
    };
  }
  if (file.endsWith(".pipe.ts")) {
    return { source: "pipe", label: "pipe", kind: "ui-flow", trustBoundaries: ["serialization"] };
  }
  if (/(^|\/)(experiment|experiments|feature-flag|featureFlags|flags|remote-config)/iu.test(file)) {
    return {
      source: "experiment",
      label: "experiment",
      kind: "config",
      trustBoundaries: ["external-api", "serialization"],
    };
  }
  return null;
}

function mergeSeeds(seeds: FeatureSeed[]): FeatureSeed[] {
  const byKey = new Map<string, FeatureSeed>();
  for (const seed of seeds) {
    const key =
      seed.identityKey ??
      `${seed.kind}:${seed.source}:${seed.entryPath}:${seed.route ?? seed.symbol ?? ""}`;
    const previous = byKey.get(key);
    if (previous === undefined) {
      byKey.set(key, seed);
      continue;
    }
    previous.ownedFiles = uniqueFileRefs([
      ...(previous.ownedFiles ?? []),
      ...(seed.ownedFiles ?? []),
    ]);
    previous.contextFiles = uniqueFileRefs([
      ...(previous.contextFiles ?? []),
      ...(seed.contextFiles ?? []),
    ]);
    previous.tests = uniqueTests([...(previous.tests ?? []), ...(seed.tests ?? [])]);
    previous.tags = [...new Set([...previous.tags, ...seed.tags])];
    previous.trustBoundaries = [...new Set([...previous.trustBoundaries, ...seed.trustBoundaries])];
  }
  return [...byKey.values()];
}

function uniqueFileRefs(refs: SeedFileRef[]): SeedFileRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.path)) {
      return false;
    }
    seen.add(ref.path);
    return true;
  });
}

function uniqueTests(tests: SeedTestRef[]): SeedTestRef[] {
  const seen = new Set<string>();
  return tests.filter((test) => {
    if (seen.has(test.path)) {
      return false;
    }
    seen.add(test.path);
    return true;
  });
}

function isRouteFileCandidate(file: string): boolean {
  return routeFilePattern.test(file) || file.endsWith(".module.ts");
}

function isAngularSource(file: string): boolean {
  return /\.(ts|html|scss|sass|css|less|json)$/u.test(file) && !/\.d\.ts$/u.test(file);
}

function isJsTestPath(file: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(file);
}

function displayName(file: string): string {
  return basename(file)
    .replace(/\.(page|component|service|guard|resolver|directive|pipe)\.ts$/u, "")
    .replace(/-/gu, " ");
}

function symbolName(file: string): string {
  return basename(file)
    .replace(/\.(page|component|service|guard|resolver|directive|pipe)\.ts$/u, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase();
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function tagForDependency(dep: string): string {
  if (dep.includes("ionic")) {
    return "ionic";
  }
  if (dep.includes("capacitor")) {
    return "capacitor";
  }
  if (dep.includes("fire") || dep.includes("firebase")) {
    return dep === "@angular/fire" ? "angular-fire" : "firebase";
  }
  return "angular";
}

function tagForConfig(file: string): string {
  if (file.startsWith("ionic")) {
    return "ionic";
  }
  if (file.startsWith("capacitor")) {
    return "capacitor";
  }
  if (file.includes("firebase") || file === ".firebaserc") {
    return "firebase";
  }
  return "angular";
}
