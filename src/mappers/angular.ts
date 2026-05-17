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
import type { TrustBoundary } from "../types.js";
import type { NodeProjectInfo } from "./projects.js";
import type { WorkspaceTaskGraph } from "./task-graph.js";
import { FeatureSeed, MapperContext, SeedFileRef, SeedTestRef } from "./types.js";

type AngularPackage = {
  project: NodeProjectInfo;
  tags: string[];
  testCommand: string | null | undefined;
  contextFiles: SeedFileRef[];
};

type SourceIndex = {
  root: string;
  info: AngularPackage;
  prefixes: string[];
  files: string[];
  fileSet: Set<string>;
  sources: Map<string, string>;
  routeGroups: RouteGroup[];
  routeGroupsByFile: Map<string, RouteGroup[]>;
  tsConfigs: TsConfigInfo[];
  angularJson: AngularJsonInfo | null;
  modalCallers: Map<string, SeedFileRef[]>;
  routeReferencedGuards: Map<string, RouteSymbolRef[]>;
  routeReferencedResolvers: Map<string, RouteSymbolRef[]>;
};

type TsConfigInfo = {
  path: string;
  baseUrl: string | null;
  paths: TsPathMapping[];
};

type TsPathMapping = {
  pattern: string;
  targets: string[];
};

type AngularJsonInfo = {
  sourceRoots: string[];
  fileReplacements: Array<{ replace: string; with: string }>;
  styles: string[];
  projectTags: string[];
};

type ImportBinding = {
  symbol: string;
  importedName: string | null;
  moduleSpecifier: string;
  resolvedPath: string | null;
  namespace: boolean;
};

type ImportIndex = {
  symbols: Map<string, ImportBinding>;
  namespaces: Map<string, ImportBinding>;
};

type RouteGroup = {
  file: string;
  kind: "root" | "child" | "unknown";
  routes: ParsedRoute[];
};

type ParsedRoute = {
  pathSegment: string | null;
  matcher: string | null;
  component: string | null;
  loadComponent: LazyImport | null;
  loadChildren: LazyImport | null;
  redirectTo: string | null;
  pathMatch: string | null;
  outlet: string | null;
  title: string | null;
  data: DataEntry[];
  guards: RouteSymbolRef[];
  resolvers: RouteSymbolRef[];
  providers: string[];
  children: ParsedRoute[];
  declarationPath: string;
};

type LazyImport = {
  specifier: string;
  symbol: string | null;
  legacy: boolean;
};

type RouteSymbolRef = {
  field: string;
  symbol: string;
  path: string | null;
};

type DataEntry = {
  key: string;
  value: string | null;
};

type RouteContext = {
  declarations: SeedFileRef[];
  lazyTargets: SeedFileRef[];
  guards: RouteSymbolRef[];
  resolvers: RouteSymbolRef[];
  data: DataEntry[];
  titles: string[];
  redirects: string[];
  outlets: string[];
  providers: string[];
};

type ResolvedRoute = {
  routePath: string;
  entryPath: string;
  symbol: string | null;
  confidence: FeatureSeed["confidence"];
  context: RouteContext;
  summaryParts: string[];
};

type AngularRole = {
  source: string;
  label: string;
  kind: FeatureSeed["kind"];
  tags: string[];
  trustBoundaries: TrustBoundary[];
};

const angularDeps = [
  "@angular/core",
  "@angular/router",
  "@angular/cli",
  "@angular/common",
  "@angular/forms",
  "@ionic/angular",
  "@capacitor/core",
  "@angular/fire",
  "firebase",
  "firebase-admin",
];

const angularProjectFiles = [
  "angular.json",
  "ionic.config.json",
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.json",
  "firebase.json",
  ".firebaserc",
  "karma.conf.js",
  "tsconfig.app.json",
  "tsconfig.spec.json",
];

const tsConfigNames = ["tsconfig.json", "tsconfig.app.json", "tsconfig.spec.json"];

const routeFilePattern =
  /(^|\/)(app\.routes|[^/]+\.routes|app-routing\.module|[^/]+-routing\.module)\.ts$/u;

const routeGuardFields = [
  "canActivate",
  "canActivateChild",
  "canDeactivate",
  "canLoad",
  "canMatch",
] as const;

const modalNamePattern =
  /(^|[-_.])(modal|popup|dialog|drawer|sheet|popover|alert|confirmation)([-_.]|$)/iu;

const companionSuffixes = [
  ".html",
  ".scss",
  ".sass",
  ".css",
  ".less",
  ".spec.ts",
  ".test.ts",
  ".spec.tsx",
  ".test.tsx",
  ".module.ts",
  "-routing.module.ts",
  ".routes.ts",
  ".model.ts",
  ".models.ts",
  ".type.ts",
  ".types.ts",
  ".const.ts",
  ".consts.ts",
  ".constant.ts",
  ".constants.ts",
  ".enum.ts",
  ".schema.ts",
  ".validator.ts",
  ".service.ts",
  ".service.spec.ts",
  ".service.test.ts",
];

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

  for (const file of angularProjectFiles) {
    if (await pathExists(join(root, packageRelativePath(project.root, file)))) {
      tags.add(tagForConfig(file));
    }
  }

  const angularJson = await readAngularJson(root, project);
  for (const tag of angularJson?.projectTags ?? []) {
    tags.add(tag);
  }

  const sourceSignals = await existingSourceSignals(root, project, angularJson);
  for (const signal of sourceSignals) {
    tags.add(signal);
  }

  return uniqueSorted([...tags]);
}

async function existingSourceSignals(
  root: string,
  project: NodeProjectInfo,
  angularJson: AngularJsonInfo | null,
): Promise<string[]> {
  const tags = new Set<string>();
  const roots = uniqueSorted([
    ...(project.sourceRoot === null ? [] : [project.sourceRoot]),
    ...(angularJson?.sourceRoots ?? []),
    packageRelativePath(project.root, "src"),
    packageRelativePath(project.root, "src/app"),
    packageRelativePath(project.root, "app"),
  ]);

  const candidates = [
    "main.ts",
    "app.module.ts",
    "app.config.ts",
    "app.routes.ts",
    "app-routing.module.ts",
  ];
  for (const rootPath of roots) {
    for (const candidate of candidates) {
      if (await pathExists(join(root, rootPath, candidate))) {
        tags.add("angular");
      }
      if (await pathExists(join(root, rootPath, "app", candidate))) {
        tags.add("angular");
      }
    }
    if (await pathExists(join(root, rootPath, "app"))) {
      tags.add("angular");
    }
  }

  return [...tags];
}

async function angularProjectSeeds(root: string, info: AngularPackage): Promise<FeatureSeed[]> {
  const index = await buildSourceIndex(root, info);
  const routedEntries = new Set<string>();
  const seeds: FeatureSeed[] = [];

  const routes = routeSeeds(index);
  for (const seed of routes) {
    routedEntries.add(seed.entryPath);
    seeds.push(seed);
  }

  seeds.push(...componentSeeds(index, routedEntries));
  seeds.push(...roleSeeds(index));
  seeds.push(...configSeeds(index));

  return mergeSeeds(seeds);
}

async function buildSourceIndex(root: string, info: AngularPackage): Promise<SourceIndex> {
  const [angularJson, tsConfigs] = await Promise.all([
    readAngularJson(root, info.project),
    readTsConfigs(root, info.project),
  ]);
  const prefixes = await sourcePrefixes(root, info.project, angularJson, tsConfigs);
  const files = uniqueSorted([
    ...(await walk(root, prefixes)).filter(isAngularSource),
    ...(await existingAngularConfigPaths(root, info.project)),
  ]);
  const fileSet = new Set(files);
  const sources = new Map<string, string>();
  await Promise.all(
    files
      .filter((file) => /\.(ts|html|scss|sass|css|less|json)$/u.test(file))
      .map(async (file) => {
        sources.set(file, await readFile(join(root, file), "utf8"));
      }),
  );

  const routeGroups = files
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !isJsTestPath(file))
    .flatMap((file) => routeGroupsFromSource(file, sources.get(file) ?? ""));
  const routeGroupsByFile = groupsByFile(routeGroups);

  const partial: SourceIndex = {
    root,
    info,
    prefixes,
    files,
    fileSet,
    sources,
    routeGroups,
    routeGroupsByFile,
    tsConfigs,
    angularJson,
    modalCallers: new Map(),
    routeReferencedGuards: new Map(),
    routeReferencedResolvers: new Map(),
  };

  partial.modalCallers = modalCallers(partial);
  registerRouteReferences(partial);
  return partial;
}

async function existingAngularConfigPaths(
  root: string,
  project: NodeProjectInfo,
): Promise<string[]> {
  const candidates = [
    ...angularProjectFiles,
    "tsconfig.json",
    "src/main.ts",
    "src/polyfills.ts",
    "src/app/app.module.ts",
    "src/app/app.config.ts",
    "src/app/app.routes.ts",
    "src/app/app-routing.module.ts",
  ].map((path) => packageRelativePath(project.root, path));
  const existing: string[] = [];
  for (const path of candidates) {
    if (await pathExists(join(root, path))) {
      existing.push(path);
    }
  }
  return existing;
}

async function sourcePrefixes(
  root: string,
  project: NodeProjectInfo,
  angularJson: AngularJsonInfo | null,
  tsConfigs: TsConfigInfo[],
): Promise<string[]> {
  const prefixes = new Set<string>();
  if (project.sourceRoot !== null) {
    prefixes.add(project.sourceRoot);
  }
  for (const sourceRoot of angularJson?.sourceRoots ?? []) {
    prefixes.add(sourceRoot);
  }
  for (const tsConfig of tsConfigs) {
    for (const prefix of await tsConfigIncludePrefixes(root, project, tsConfig.path)) {
      prefixes.add(prefix);
    }
  }
  for (const fallback of ["src", "src/app", "app"]) {
    prefixes.add(packageRelativePath(project.root, fallback));
  }
  return uniqueSorted([...prefixes].filter((prefix) => !shouldSkip(prefix)));
}

async function tsConfigIncludePrefixes(
  root: string,
  project: NodeProjectInfo,
  path: string,
): Promise<string[]> {
  const parsed = await readJsonObject(root, path);
  const includes = asStringArray(parsed?.["include"]);
  const prefixes: string[] = [];
  for (const include of includes) {
    const prefix = prefixFromIncludeGlob(include);
    if (prefix === null) {
      continue;
    }
    const normalized = packageRelativePath(project.root, prefix);
    if (isBoundedProjectPath(project.root, normalized)) {
      prefixes.push(normalized);
    }
  }
  return uniqueSorted(prefixes);
}

function prefixFromIncludeGlob(include: string): string | null {
  const normalized = normalize(include).replace(/^\.\//u, "");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return null;
  }
  const globIndex = normalized.search(/[*{[]/u);
  const beforeGlob = globIndex === -1 ? normalized : normalized.slice(0, globIndex);
  const trimmed = beforeGlob.replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    return ".";
  }
  if (/\.[A-Za-z0-9]+$/u.test(trimmed)) {
    const dir = dirname(trimmed);
    return dir === "." ? "." : dir;
  }
  return trimmed;
}

function isBoundedProjectPath(projectRoot: string, path: string): boolean {
  return projectRoot === "." || path === projectRoot || pathMatchesPrefix(path, projectRoot);
}

async function readAngularJson(
  root: string,
  project: NodeProjectInfo,
): Promise<AngularJsonInfo | null> {
  const path = packageRelativePath(project.root, "angular.json");
  const parsed = await readJsonObject(root, path);
  if (parsed === null) {
    return null;
  }

  const sourceRoots = new Set<string>();
  const fileReplacements: Array<{ replace: string; with: string }> = [];
  const styles = new Set<string>();
  const angularProjectTags = new Set<string>();
  const projects = asRecord(parsed["projects"]);
  for (const [name, rawProject] of Object.entries(projects)) {
    const projectConfig = asRecord(rawProject);
    angularProjectTags.add(`project:${name}`);
    const sourceRoot = asString(projectConfig["sourceRoot"]);
    if (sourceRoot !== null) {
      sourceRoots.add(packageRelativePath(project.root, sourceRoot));
    }
    const projectType = asString(projectConfig["projectType"]);
    if (projectType !== null) {
      angularProjectTags.add(`project-type:${projectType}`);
    }
    collectArchitectConfig(project.root, projectConfig, fileReplacements, styles);
  }

  return {
    sourceRoots: uniqueSorted([...sourceRoots]),
    fileReplacements: uniqueSortedByPath(fileReplacements, (replacement) => replacement.replace),
    styles: uniqueSorted([...styles]),
    projectTags: uniqueSorted([...angularProjectTags, "angular"]),
  };
}

function collectArchitectConfig(
  projectRoot: string,
  projectConfig: Record<string, unknown>,
  fileReplacements: Array<{ replace: string; with: string }>,
  styles: Set<string>,
): void {
  const architect = asRecord(projectConfig["architect"] ?? projectConfig["targets"]);
  for (const target of Object.values(architect)) {
    const targetConfig = asRecord(target);
    collectBuildOptions(projectRoot, asRecord(targetConfig["options"]), fileReplacements, styles);
    const configurations = asRecord(targetConfig["configurations"]);
    for (const configuration of Object.values(configurations)) {
      collectBuildOptions(projectRoot, asRecord(configuration), fileReplacements, styles);
    }
  }
}

function collectBuildOptions(
  projectRoot: string,
  options: Record<string, unknown>,
  fileReplacements: Array<{ replace: string; with: string }>,
  styles: Set<string>,
): void {
  for (const style of asStringArray(options["styles"])) {
    if (!style.startsWith("node_modules/")) {
      styles.add(packageRelativePath(projectRoot, style));
    }
  }
  for (const replacement of asArray(options["fileReplacements"])) {
    const record = asRecord(replacement);
    const replace = asString(record["replace"]);
    const withPath = asString(record["with"]);
    if (replace !== null && withPath !== null) {
      fileReplacements.push({
        replace: packageRelativePath(projectRoot, replace),
        with: packageRelativePath(projectRoot, withPath),
      });
    }
  }
}

async function readTsConfigs(root: string, project: NodeProjectInfo): Promise<TsConfigInfo[]> {
  const configs: TsConfigInfo[] = [];
  for (const name of tsConfigNames) {
    const path = packageRelativePath(project.root, name);
    const parsed = await readJsonObject(root, path);
    if (parsed === null) {
      continue;
    }
    const compilerOptions = asRecord(parsed["compilerOptions"]);
    configs.push({
      path,
      baseUrl: asString(compilerOptions["baseUrl"]),
      paths: Object.entries(asRecord(compilerOptions["paths"])).flatMap(([pattern, targets]) => {
        const strings = asStringArray(targets);
        return strings.length === 0 ? [] : [{ pattern, targets: strings }];
      }),
    });
  }
  return configs;
}

async function readJsonObject(root: string, path: string): Promise<Record<string, unknown> | null> {
  if (!(await pathExists(join(root, path)))) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(await readFile(join(root, path), "utf8")));
    return asRecordOrNull(parsed);
  } catch {
    return null;
  }
}

function routeGroupsFromSource(file: string, source: string): RouteGroup[] {
  const sanitized = maskComments(source);
  const namedArrays = namedRouteArrays(sanitized);
  const groups: RouteGroup[] = [];
  const seen = new Set<string>();

  for (const call of routeCallArrays(sanitized, namedArrays)) {
    const routes = routeNodesFromArray(file, call.arraySource, namedArrays);
    if (routes.length === 0) {
      continue;
    }
    const key = `${call.kind}:${call.arraySource}`;
    if (!seen.has(key)) {
      seen.add(key);
      groups.push({ file, kind: call.kind, routes });
    }
  }

  if (isRouteFileCandidate(file)) {
    const defaultKind = isRootRouteFile(file) ? "root" : "unknown";
    for (const [name, arraySource] of namedArrays) {
      const routes = routeNodesFromArray(file, arraySource, namedArrays);
      const key = `${defaultKind}:${name}:${arraySource}`;
      if (routes.length > 0 && !seen.has(key)) {
        seen.add(key);
        groups.push({ file, kind: defaultKind, routes });
      }
    }
  }

  return groups;
}

function namedRouteArrays(source: string): Map<string, string> {
  const arrays = new Map<string, string>();
  const pattern = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=]+)?\s*=/gu;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const start = skipWhitespace(source, match.index + match[0].length);
    if (name !== undefined && source[start] === "[") {
      const array = readBalanced(source, start, "[", "]");
      if (array !== null) {
        arrays.set(name, array);
      }
    }
  }
  return arrays;
}

function routeCallArrays(
  source: string,
  namedArrays: Map<string, string>,
): Array<{ kind: RouteGroup["kind"]; arraySource: string }> {
  const arrays: Array<{ kind: RouteGroup["kind"]; arraySource: string }> = [];
  const pattern = /(?:RouterModule\.for(?:Root|Child)|provideRouter|provideRoutes)\s*\(/gu;
  for (const match of source.matchAll(pattern)) {
    const callee = match[0];
    const kind: RouteGroup["kind"] =
      callee.includes("forRoot") || callee.includes("provideRouter") ? "root" : "child";
    const start = skipWhitespace(source, match.index + match[0].length);
    if (source[start] === "[") {
      const array = readBalanced(source, start, "[", "]");
      if (array !== null) {
        arrays.push({ kind, arraySource: array });
      }
      continue;
    }
    const name = readIdentifier(source, start);
    const array = name === null ? undefined : namedArrays.get(name);
    if (array !== undefined) {
      arrays.push({ kind, arraySource: array });
    }
  }
  return arrays;
}

function routeNodesFromArray(
  file: string,
  arraySource: string,
  namedArrays: Map<string, string>,
): ParsedRoute[] {
  return topLevelArrayItems(arraySource).flatMap((item) => {
    const trimmed = item.trim();
    if (trimmed.startsWith("...")) {
      const name = readIdentifier(trimmed, 3);
      const spread = name === null ? undefined : namedArrays.get(name);
      return spread === undefined ? [] : routeNodesFromArray(file, spread, namedArrays);
    }
    if (!trimmed.startsWith("{")) {
      return [];
    }
    const route = parseRouteObject(file, trimmed, namedArrays);
    return route === null ? [] : [route];
  });
}

function parseRouteObject(
  file: string,
  objectSource: string,
  namedArrays: Map<string, string>,
): ParsedRoute | null {
  const pathSegment = topLevelStringProp(objectSource, "path");
  const matcher = topLevelSymbolProp(objectSource, "matcher");
  const component = topLevelSymbolProp(objectSource, "component");
  const loadComponent = lazyImport(topLevelPropSource(objectSource, "loadComponent"));
  const loadChildren = lazyImport(topLevelPropSource(objectSource, "loadChildren"));
  const redirectTo = topLevelStringProp(objectSource, "redirectTo");
  const pathMatch = topLevelStringProp(objectSource, "pathMatch");
  const outlet = topLevelStringProp(objectSource, "outlet");
  const title = literalSummary(topLevelPropSource(objectSource, "title"));
  const children = topLevelArrayProp(objectSource, "children");
  const data = objectEntries(topLevelPropSource(objectSource, "data"));
  const guards = routeGuardFields.flatMap((field) =>
    symbolRefs(field, topLevelPropSource(objectSource, field)),
  );
  const resolvers = resolverRefs(topLevelPropSource(objectSource, "resolve"));
  const providers = symbolList(topLevelPropSource(objectSource, "providers"));
  if (
    pathSegment === null &&
    matcher === null &&
    component === null &&
    loadComponent === null &&
    loadChildren === null &&
    redirectTo === null &&
    children === null
  ) {
    return null;
  }
  return {
    pathSegment,
    matcher,
    component,
    loadComponent,
    loadChildren,
    redirectTo,
    pathMatch,
    outlet,
    title,
    data,
    guards,
    resolvers,
    providers,
    children: children === null ? [] : routeNodesFromArray(file, children, namedArrays),
    declarationPath: file,
  };
}

function routeSeeds(index: SourceIndex): FeatureSeed[] {
  const roots = rootRouteGroups(index);
  const resolved = roots.flatMap((group) =>
    resolveRoutes(index, group.routes, "", emptyRouteContext(), new Set([group.file])),
  );
  return mergeRouteRecords(resolved).map((route) => routeSeed(index, route));
}

function rootRouteGroups(index: SourceIndex): RouteGroup[] {
  const rootGroups = index.routeGroups.filter((group) => group.kind === "root");
  if (rootGroups.length > 0) {
    return rootGroups.toSorted((left, right) => left.file.localeCompare(right.file));
  }
  return index.routeGroups.toSorted((left, right) => left.file.localeCompare(right.file));
}

function resolveRoutes(
  index: SourceIndex,
  routes: ParsedRoute[],
  parentPath: string,
  inherited: RouteContext,
  stack: Set<string>,
): ResolvedRoute[] {
  const output: ResolvedRoute[] = [];
  for (const route of routes) {
    const routePath = composeRoute(parentPath, route.pathSegment, route.matcher);
    const context = mergeRouteContext(inherited, contextForRoute(index, route));
    const componentEntry =
      route.component === null
        ? null
        : resolveSymbol(index, route.declarationPath, route.component, "component");
    const loadComponentEntry =
      route.loadComponent === null
        ? null
        : resolveLazyImport(index, route.declarationPath, route.loadComponent, "component");
    const lazyModuleEntry =
      route.loadChildren === null
        ? null
        : resolveLazyImport(index, route.declarationPath, route.loadChildren, "module");

    if (componentEntry !== null || loadComponentEntry !== null) {
      const entry = componentEntry ?? loadComponentEntry;
      if (entry !== null) {
        output.push({
          routePath,
          entryPath: entry.path,
          symbol: route.component ?? route.loadComponent?.symbol ?? entry.symbol,
          confidence: entry.confidence,
          context,
          summaryParts: routeSummaryParts(route, context),
        });
      }
    }

    if (route.children.length > 0) {
      output.push(...resolveRoutes(index, route.children, routePath, context, stack));
    }

    if (lazyModuleEntry !== null) {
      const childGroups = lazyRouteGroups(index, lazyModuleEntry.path);
      if (childGroups.length === 0) {
        if (!isRedirectOnly(route)) {
          output.push({
            routePath,
            entryPath: lazyModuleEntry.path,
            symbol: route.loadChildren?.symbol ?? lazyModuleEntry.symbol,
            confidence:
              lazyModuleEntry.confidence === "high" ? "medium" : lazyModuleEntry.confidence,
            context: mergeRouteContext(context, {
              ...emptyRouteContext(),
              lazyTargets: [{ path: lazyModuleEntry.path, reason: "lazy route target" }],
            }),
            summaryParts: routeSummaryParts(route, context),
          });
        }
        continue;
      }

      for (const childGroup of childGroups) {
        const key = `${lazyModuleEntry.path}:${childGroup.file}:${routePath}`;
        if (stack.has(key)) {
          continue;
        }
        const nextStack = new Set(stack);
        nextStack.add(key);
        output.push(
          ...resolveRoutes(
            index,
            childGroup.routes,
            routePath,
            mergeRouteContext(context, {
              ...emptyRouteContext(),
              lazyTargets: [
                { path: lazyModuleEntry.path, reason: "lazy route target" },
                { path: childGroup.file, reason: "lazy route declaration" },
              ],
            }),
            nextStack,
          ),
        );
      }
    } else if (isBehavioralRedirect(route)) {
      const target = redirectTargetPath(parentPath, route.redirectTo);
      if (target === null) {
        output.push({
          routePath,
          entryPath: route.declarationPath,
          symbol: null,
          confidence: "low",
          context,
          summaryParts: routeSummaryParts(route, context),
        });
      }
    }
  }
  return output;
}

function routeSeed(index: SourceIndex, route: ResolvedRoute): FeatureSeed {
  const tests = associatedTests(index, [route.entryPath]);
  const companions = componentCompanionRefs(index, route.entryPath, true);
  const featureServices = featureLocalInjectedServices(index, route.entryPath);
  const guardRefs = route.context.guards
    .filter((guard) => guard.path !== null)
    .map((guard) => ({ path: guard.path ?? "", reason: `${guard.field} guard ${guard.symbol}` }));
  const resolvedResolverRefs = route.context.resolvers
    .filter((resolver) => resolver.path !== null)
    .map((resolver) => ({
      path: resolver.path ?? "",
      reason: `${resolver.field} resolver ${resolver.symbol}`,
    }));
  const dataRefs = route.context.data.map((entry) => ({
    path: firstDeclaration(route.context),
    reason:
      entry.value === null ? `route data ${entry.key}` : `route data ${entry.key}=${entry.value}`,
  }));

  return {
    title: `Angular route ${route.routePath}`,
    summary: routeSummary(route),
    kind: "route",
    source: "angular-route",
    confidence: route.confidence,
    entryPath: route.entryPath,
    identityKey: `angular:route:${index.info.project.root}:${route.routePath}:${route.entryPath}`,
    symbol: route.symbol,
    route: route.routePath,
    command: null,
    ownedFiles: uniqueFileRefs([
      { path: route.entryPath, reason: "entrypoint" },
      ...companions,
      ...route.context.declarations,
      ...route.context.lazyTargets,
    ]),
    contextFiles: uniqueFileRefs([
      ...index.info.contextFiles,
      ...guardRefs,
      ...resolvedResolverRefs,
      ...dataRefs,
      ...featureServices.map((path) => ({ path, reason: "feature service" })),
      ...modalContextRefs(index, route.entryPath),
      ...tests.map((test) => ({ path: test.path, reason: "test" })),
    ]),
    tests,
    tags: angularSeedTags(index, ["route"]),
    trustBoundaries: routeTrustBoundaries(route),
    skipNearbyTests: true,
  };
}

function routeSummary(route: ResolvedRoute): string {
  const parts = [`Angular/Ionic route '${route.routePath}' maps to ${route.entryPath}`];
  for (const part of route.summaryParts) {
    parts.push(part);
  }
  return `${parts.join("; ")}.`;
}

function routeSummaryParts(route: ParsedRoute, context: RouteContext): string[] {
  const parts: string[] = [];
  if (route.redirectTo !== null) {
    parts.push(`redirects to ${route.redirectTo}`);
  }
  if (route.pathMatch !== null) {
    parts.push(`pathMatch ${route.pathMatch}`);
  }
  if (route.outlet !== null) {
    parts.push(`outlet ${route.outlet}`);
  }
  if (route.title !== null) {
    parts.push(`title ${route.title}`);
  }
  if (context.guards.length > 0) {
    parts.push(`guards ${context.guards.map((guard) => guard.symbol).join(", ")}`);
  }
  if (context.resolvers.length > 0) {
    parts.push(`resolvers ${context.resolvers.map((resolver) => resolver.symbol).join(", ")}`);
  }
  if (context.data.length > 0) {
    parts.push(
      `data ${context.data
        .map((entry) => (entry.value === null ? entry.key : `${entry.key}=${entry.value}`))
        .join(", ")}`,
    );
  }
  return uniqueSorted(parts);
}

function componentSeeds(index: SourceIndex, routedEntries: Set<string>): FeatureSeed[] {
  const components = index.files
    .filter((file) => /\.(page|component)\.ts$/u.test(file))
    .filter((file) => !isJsTestPath(file))
    .filter((file) => !routedEntries.has(file))
    .filter((file) => isProductionSourcePath(file))
    .filter((file) => isAngularComponent(index, file))
    .toSorted();

  return components.map((file) => {
    const modal = isModalComponent(index, file);
    const shell = isShellComponent(file);
    const source = modal
      ? "angular-modal-component"
      : shell
        ? "angular-shell-component"
        : file.endsWith(".page.ts")
          ? "angular-page-component"
          : "angular-component";
    const identityPrefix = modal ? "modal" : shell ? "shell" : "component";
    const tests = associatedTests(index, [file]);
    return {
      title: `${modal ? "Ionic modal" : shell ? "Angular shell" : "Angular component"} ${displayName(file)}`,
      summary: `${modal ? "Ionic modal/popover" : "Angular/Ionic component"} implemented by ${file}.`,
      kind: "ui-flow",
      source,
      confidence: modal || hasDecorator(index, file, "Component") ? "high" : "medium",
      entryPath: file,
      identityKey: `angular:${identityPrefix}:${index.info.project.root}:${file}`,
      symbol: exportedSymbolName(index, file) ?? symbolName(file),
      route: null,
      command: null,
      ownedFiles: uniqueFileRefs([
        { path: file, reason: "entrypoint" },
        ...componentCompanionRefs(index, file, false),
      ]),
      contextFiles: uniqueFileRefs([
        ...index.info.contextFiles,
        ...featureLocalInjectedServices(index, file).map((path) => ({
          path,
          reason: "feature service",
        })),
        ...(index.modalCallers.get(file) ?? []),
        ...tests.map((test) => ({ path: test.path, reason: "test" })),
      ]),
      tests,
      tags: angularSeedTags(index, [modal ? "ionic-modal" : "component"]),
      trustBoundaries: modal
        ? ["user-input", "serialization"]
        : ["user-input", "network", "serialization"],
      skipNearbyTests: true,
    };
  });
}

function roleSeeds(index: SourceIndex): FeatureSeed[] {
  return index.files
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !isJsTestPath(file))
    .filter((file) => isProductionSourcePath(file))
    .flatMap((file) => {
      const role = angularRole(index, file);
      if (role === null) {
        return [];
      }
      const tests = associatedTests(index, [file]);
      return [
        {
          title: `Angular ${role.label} ${displayName(file)}`,
          summary: `Angular ${role.label} implemented by ${file}.`,
          kind: role.kind,
          source: `angular-${role.source}`,
          confidence: hasRoleDecoratorOrImport(index, file, role) ? "high" : "medium",
          entryPath: file,
          identityKey:
            role.source === "guard" || role.source === "resolver"
              ? `angular:${role.source}:${index.info.project.root}:${file}`
              : `angular:service:${index.info.project.root}:${file}`,
          symbol: exportedSymbolName(index, file) ?? symbolName(file),
          route: null,
          command: null,
          ownedFiles: uniqueFileRefs([
            { path: file, reason: "entrypoint" },
            ...semanticCompanionRefs(index, file),
          ]),
          contextFiles: uniqueFileRefs([
            ...index.info.contextFiles,
            ...directLocalImportRefs(index, file),
            ...tests.map((test) => ({ path: test.path, reason: "test" })),
          ]),
          tests,
          tags: angularSeedTags(index, [role.source, ...role.tags]),
          trustBoundaries: role.trustBoundaries,
          skipNearbyTests: true,
        } satisfies FeatureSeed,
      ];
    });
}

function configSeeds(index: SourceIndex): FeatureSeed[] {
  const seeds: FeatureSeed[] = [];
  const projectRoot = index.info.project.root;
  const singleConfigs = [
    "angular.json",
    "ionic.config.json",
    "capacitor.config.ts",
    "capacitor.config.js",
    "capacitor.config.json",
    "firebase.json",
    ".firebaserc",
    "karma.conf.js",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.spec.json",
    "src/main.ts",
    "src/polyfills.ts",
    "src/app/app.module.ts",
    "src/app/app.config.ts",
    "src/app/app.routes.ts",
    "src/app/app-routing.module.ts",
  ];

  for (const config of singleConfigs) {
    const path = packageRelativePath(projectRoot, config);
    if (!index.fileSet.has(path) && !pathExistsSyncLike(index, path)) {
      continue;
    }
    seeds.push(configSeed(index, path, config, [tagForConfig(config)]));
  }

  const envSeed = environmentSeed(index);
  if (envSeed !== null) {
    seeds.push(envSeed);
  }

  for (const style of index.angularJson?.styles ?? []) {
    if (index.fileSet.has(style)) {
      seeds.push(configSeed(index, style, basename(style), ["angular-style"]));
    }
  }

  return mergeSeeds(seeds);
}

function configSeed(
  index: SourceIndex,
  path: string,
  label: string,
  tags: string[],
  ownedFiles?: SeedFileRef[],
): FeatureSeed {
  return {
    title: `Angular config ${label}`,
    summary: `Angular/Ionic project configuration in ${path}.`,
    kind: "config",
    source: "angular-config",
    confidence: "high",
    entryPath: path,
    identityKey: `angular:config:${index.info.project.root}:${path}`,
    symbol: null,
    route: null,
    command: null,
    ...(ownedFiles === undefined ? {} : { ownedFiles }),
    contextFiles: uniqueFileRefs(index.info.contextFiles),
    tags: angularSeedTags(index, tags),
    trustBoundaries: ["filesystem", "process-exec", "secrets"],
    skipNearbyTests: true,
  };
}

function environmentSeed(index: SourceIndex): FeatureSeed | null {
  const projectRoot = index.info.project.root;
  const defaultEnv = packageRelativePath(projectRoot, "src/environments/environment.ts");
  const replacementRefs =
    index.angularJson?.fileReplacements
      .filter((replacement) => replacement.replace === defaultEnv)
      .flatMap((replacement) => [replacement.replace, replacement.with]) ?? [];
  const envFiles = index.files.filter((file) =>
    pathMatchesPrefix(file, packageRelativePath(projectRoot, "src/environments")),
  );
  const owned = uniqueFileRefs(
    uniqueSorted([defaultEnv, ...replacementRefs, ...envFiles])
      .filter((file) => index.fileSet.has(file))
      .map((path) => ({
        path,
        reason: path === defaultEnv ? "entrypoint" : "environment variant",
      })),
  );
  if (owned.length === 0) {
    return null;
  }
  const entry = owned.some((ref) => ref.path === defaultEnv) ? defaultEnv : owned[0]?.path;
  if (entry === undefined) {
    return null;
  }
  return configSeed(index, entry, "environment", ["environment"], owned);
}

function pathExistsSyncLike(index: SourceIndex, path: string): boolean {
  return index.sources.has(path) || index.files.includes(path);
}

function lazyRouteGroups(index: SourceIndex, lazyPath: string): RouteGroup[] {
  const direct = index.routeGroupsByFile.get(lazyPath) ?? [];
  const groups = [...direct];
  if (!lazyPath.endsWith(".module.ts")) {
    return uniqueRouteGroups(groups);
  }

  const source = index.sources.get(lazyPath) ?? "";
  const imports = importIndex(index, lazyPath, source);
  for (const binding of imports.symbols.values()) {
    if (
      binding.resolvedPath !== null &&
      /(?:RoutingModule|Routes?)$/u.test(binding.symbol) &&
      index.routeGroupsByFile.has(binding.resolvedPath)
    ) {
      groups.push(...(index.routeGroupsByFile.get(binding.resolvedPath) ?? []));
    }
  }

  const dir = dirname(lazyPath);
  const base = lazyPath.replace(/\.module\.ts$/u, "");
  const candidates = [
    `${base}-routing.module.ts`,
    `${base}.routes.ts`,
    `${dir}/${basename(dir)}-routing.module.ts`,
    `${dir}/${basename(dir)}.routes.ts`,
  ];
  for (const candidate of candidates) {
    groups.push(...(index.routeGroupsByFile.get(candidate) ?? []));
  }

  for (const [file, fileGroups] of index.routeGroupsByFile) {
    if (
      dirname(file) === dir &&
      (file.endsWith("-routing.module.ts") || file.endsWith(".routes.ts"))
    ) {
      groups.push(...fileGroups);
    }
  }
  return uniqueRouteGroups(groups);
}

function uniqueRouteGroups(groups: RouteGroup[]): RouteGroup[] {
  const seen = new Set<string>();
  const output: RouteGroup[] = [];
  for (const group of groups.toSorted((left, right) => left.file.localeCompare(right.file))) {
    const key = `${group.file}:${group.kind}:${group.routes.length}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(group);
    }
  }
  return output;
}

function contextForRoute(index: SourceIndex, route: ParsedRoute): RouteContext {
  return {
    declarations: [{ path: route.declarationPath, reason: "route declaration" }],
    lazyTargets: [],
    guards: route.guards.map((guard) => resolveRouteSymbol(index, route.declarationPath, guard)),
    resolvers: route.resolvers.map((resolver) =>
      resolveRouteSymbol(index, route.declarationPath, resolver),
    ),
    data: route.data,
    titles: route.title === null ? [] : [route.title],
    redirects: route.redirectTo === null ? [] : [route.redirectTo],
    outlets: route.outlet === null ? [] : [route.outlet],
    providers: route.providers,
  };
}

function mergeRouteContext(left: RouteContext, right: RouteContext): RouteContext {
  return {
    declarations: uniqueFileRefs([...left.declarations, ...right.declarations]),
    lazyTargets: uniqueFileRefs([...left.lazyTargets, ...right.lazyTargets]),
    guards: uniqueSymbolRefs([...left.guards, ...right.guards]),
    resolvers: uniqueSymbolRefs([...left.resolvers, ...right.resolvers]),
    data: uniqueDataEntries([...left.data, ...right.data]),
    titles: uniqueSorted([...left.titles, ...right.titles]),
    redirects: uniqueSorted([...left.redirects, ...right.redirects]),
    outlets: uniqueSorted([...left.outlets, ...right.outlets]),
    providers: uniqueSorted([...left.providers, ...right.providers]),
  };
}

function emptyRouteContext(): RouteContext {
  return {
    declarations: [],
    lazyTargets: [],
    guards: [],
    resolvers: [],
    data: [],
    titles: [],
    redirects: [],
    outlets: [],
    providers: [],
  };
}

function resolveRouteSymbol(
  index: SourceIndex,
  declarationPath: string,
  ref: RouteSymbolRef,
): RouteSymbolRef {
  const resolved = resolveSymbol(index, declarationPath, ref.symbol, "service");
  return { ...ref, path: resolved?.path ?? null };
}

function registerRouteReferences(index: SourceIndex): void {
  for (const group of index.routeGroups) {
    for (const route of flattenRoutes(group.routes)) {
      for (const guard of route.guards.map((ref) =>
        resolveRouteSymbol(index, route.declarationPath, ref),
      )) {
        if (guard.path !== null) {
          addMapList(index.routeReferencedGuards, guard.path, guard);
        }
      }
      for (const resolver of route.resolvers.map((ref) =>
        resolveRouteSymbol(index, route.declarationPath, ref),
      )) {
        if (resolver.path !== null) {
          addMapList(index.routeReferencedResolvers, resolver.path, resolver);
        }
      }
    }
  }
}

function flattenRoutes(routes: ParsedRoute[]): ParsedRoute[] {
  return routes.flatMap((route) => [route, ...flattenRoutes(route.children)]);
}

function resolveLazyImport(
  index: SourceIndex,
  fromFile: string,
  lazy: LazyImport,
  expected: "component" | "module",
): { path: string; symbol: string | null; confidence: FeatureSeed["confidence"] } | null {
  const resolved = resolveImportPath(index, fromFile, lazy.specifier, lazy.symbol);
  if (resolved !== null) {
    return { path: resolved, symbol: lazy.symbol, confidence: lazy.legacy ? "medium" : "high" };
  }
  const fallback =
    expected === "component"
      ? componentFallback(index, fromFile, lazy.symbol)
      : moduleFallback(index, fromFile, lazy.symbol);
  return fallback === null ? null : { path: fallback, symbol: lazy.symbol, confidence: "medium" };
}

function resolveSymbol(
  index: SourceIndex,
  fromFile: string,
  symbol: string,
  expected: "component" | "service",
): { path: string; symbol: string | null; confidence: FeatureSeed["confidence"] } | null {
  const source = index.sources.get(fromFile) ?? "";
  const imports = importIndex(index, fromFile, source);
  const [baseSymbol, namespaceMember] = splitNamespaceSymbol(symbol);
  const binding =
    namespaceMember === null ? imports.symbols.get(baseSymbol) : imports.namespaces.get(baseSymbol);
  if (binding?.resolvedPath !== null && binding?.resolvedPath !== undefined) {
    return {
      path: binding.resolvedPath,
      symbol: namespaceMember ?? binding.importedName ?? symbol,
      confidence: "high",
    };
  }
  if (fileExportsSymbol(source, symbol)) {
    return { path: fromFile, symbol, confidence: "high" };
  }
  const fallback =
    expected === "component"
      ? componentFallback(index, fromFile, symbol)
      : serviceFallback(index, fromFile, symbol);
  return fallback === null ? null : { path: fallback, symbol, confidence: "medium" };
}

function importIndex(index: SourceIndex, fromFile: string, source: string): ImportIndex {
  const imports: ImportIndex = { symbols: new Map(), namespaces: new Map() };
  const sanitized = maskComments(source);

  for (const match of sanitized.matchAll(
    /import\s+(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*\{([^}]+)\})?\s+from\s+["']([^"']+)["']/gu,
  )) {
    const defaultName = match[1];
    const named = match[2];
    const specifier = match[3];
    addImportBinding(index, imports, fromFile, defaultName, "default", specifier);
    if (named !== undefined) {
      addNamedImports(index, imports, fromFile, named, specifier);
    }
  }

  for (const match of sanitized.matchAll(
    /import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["']/gu,
  )) {
    const symbol = match[1];
    const specifier = match[2];
    if (symbol !== undefined && specifier !== undefined) {
      imports.namespaces.set(symbol, {
        symbol,
        importedName: null,
        moduleSpecifier: specifier,
        resolvedPath: resolveImportPath(index, fromFile, specifier, null),
        namespace: true,
      });
    }
  }

  for (const match of sanitized.matchAll(
    /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/gu,
  )) {
    addNamedImports(index, imports, fromFile, match[1] ?? "", match[2]);
  }

  return imports;
}

function addNamedImports(
  index: SourceIndex,
  imports: ImportIndex,
  fromFile: string,
  named: string,
  specifier: string | undefined,
): void {
  for (const part of named.split(",")) {
    const clean = part.trim().replace(/^type\s+/u, "");
    if (clean.length === 0) {
      continue;
    }
    const [importedRaw, aliasRaw] = clean.split(/\s+as\s+/u);
    const imported = importedRaw?.trim();
    const alias = aliasRaw?.trim() ?? imported;
    addImportBinding(index, imports, fromFile, alias, imported ?? null, specifier);
  }
}

function addImportBinding(
  index: SourceIndex,
  imports: ImportIndex,
  fromFile: string,
  symbol: string | undefined | null,
  importedName: string | null,
  specifier: string | undefined,
): void {
  if (symbol === undefined || symbol === null || symbol.length === 0 || specifier === undefined) {
    return;
  }
  imports.symbols.set(symbol, {
    symbol,
    importedName,
    moduleSpecifier: specifier,
    resolvedPath: resolveImportPath(index, fromFile, specifier, importedName),
    namespace: false,
  });
}

function resolveImportPath(
  index: SourceIndex,
  fromFile: string,
  specifier: string | null,
  symbol: string | null,
): string | null {
  if (
    specifier === null ||
    specifier.length === 0 ||
    specifier.startsWith("/") ||
    isPackageImport(specifier)
  ) {
    return null;
  }

  const bases = moduleCandidateBases(index, fromFile, specifier);
  for (const base of bases) {
    const resolved = resolveCandidateBase(index, fromFile, base, symbol);
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

function moduleCandidateBases(index: SourceIndex, fromFile: string, specifier: string): string[] {
  if (specifier.startsWith(".")) {
    return [normalize(join(dirname(fromFile), specifier))];
  }

  const bases = new Set<string>();
  if (index.fileSet.has(specifier) || specifier.startsWith("src/")) {
    bases.add(specifier);
  }
  for (const tsConfig of index.tsConfigs) {
    const configDir = dirname(tsConfig.path);
    const baseRoot =
      tsConfig.baseUrl === null
        ? configDir
        : normalize(join(configDir, tsConfig.baseUrl)).replace(/\/\.$/u, "");
    bases.add(normalize(join(baseRoot, specifier)));
    for (const mapping of tsConfig.paths) {
      for (const mapped of mappedPathCandidates(mapping, specifier)) {
        bases.add(normalize(join(configDir, mapped)));
        bases.add(normalize(join(baseRoot, mapped)));
      }
    }
  }
  bases.add(packageRelativePath(index.info.project.root, specifier));
  return uniqueSorted([...bases]);
}

function mappedPathCandidates(mapping: TsPathMapping, specifier: string): string[] {
  const star = mapping.pattern.indexOf("*");
  if (star === -1) {
    return mapping.pattern === specifier ? mapping.targets : [];
  }
  const prefix = mapping.pattern.slice(0, star);
  const suffix = mapping.pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return [];
  }
  const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
  return mapping.targets.map((target) => target.replace("*", matched));
}

function resolveCandidateBase(
  index: SourceIndex,
  fromFile: string,
  base: string,
  symbol: string | null,
): string | null {
  for (const candidate of moduleCandidates(base)) {
    if (!index.fileSet.has(candidate)) {
      continue;
    }
    if (candidate.endsWith("/index.ts") && symbol !== null && symbol !== "default") {
      return resolveBarrelExport(index, candidate, symbol) ?? candidate;
    }
    return candidate;
  }

  const indexPath = `${base}/index.ts`;
  if (index.fileSet.has(indexPath) && symbol !== null && symbol !== "default") {
    return resolveBarrelExport(index, indexPath, symbol) ?? indexPath;
  }

  if (fromFile === base) {
    return fromFile;
  }
  return null;
}

function moduleCandidates(base: string): string[] {
  if (/\.(ts|tsx|js|jsx|json)$/u.test(base)) {
    return [base];
  }
  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.page.ts`,
    `${base}.component.ts`,
    `${base}.service.ts`,
    `${base}.guard.ts`,
    `${base}.resolver.ts`,
    `${base}.module.ts`,
    `${base}.routes.ts`,
    `${base}-routing.module.ts`,
    `${base}/index.ts`,
  ];
}

function resolveBarrelExport(index: SourceIndex, indexPath: string, symbol: string): string | null {
  const source = index.sources.get(indexPath) ?? "";
  const sanitized = maskComments(source);
  for (const match of sanitized.matchAll(/export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/gu)) {
    const specifier = match[2];
    for (const part of (match[1] ?? "").split(",")) {
      const [importedRaw, exportedRaw] = part.trim().split(/\s+as\s+/u);
      const imported = importedRaw?.trim();
      const exported = exportedRaw?.trim() ?? imported;
      if (exported === symbol && specifier !== undefined) {
        return resolveImportPath(index, indexPath, specifier, imported ?? symbol);
      }
    }
  }
  for (const match of sanitized.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/gu)) {
    const specifier = match[1];
    const resolved = resolveImportPath(index, indexPath, specifier ?? null, symbol);
    if (resolved !== null && fileExportsSymbol(index.sources.get(resolved) ?? "", symbol)) {
      return resolved;
    }
  }
  return fileExportsSymbol(source, symbol) ? indexPath : null;
}

function componentFallback(
  index: SourceIndex,
  routeFile: string,
  component: string | null,
): string | null {
  if (component === null) {
    return null;
  }
  const expected = kebab(component.replace(/(?:Page|Component)$/u, ""));
  const dir = dirname(routeFile);
  return (
    index.files.find(
      (file) =>
        pathMatchesPrefix(file, dir) &&
        /\.(page|component)\.ts$/u.test(file) &&
        basename(file).includes(expected),
    ) ?? null
  );
}

function moduleFallback(
  index: SourceIndex,
  routeFile: string,
  symbol: string | null,
): string | null {
  if (symbol === null) {
    return null;
  }
  const expected = kebab(symbol.replace(/(?:Page)?Module$/u, ""));
  const dir = dirname(routeFile);
  return (
    index.files.find(
      (file) =>
        pathMatchesPrefix(file, dir) &&
        file.endsWith(".module.ts") &&
        basename(file).includes(expected),
    ) ?? null
  );
}

function serviceFallback(
  index: SourceIndex,
  routeFile: string,
  symbol: string | null,
): string | null {
  if (symbol === null) {
    return null;
  }
  const expected = kebab(symbol.replace(/(?:Service|Guard|Resolver)$/u, ""));
  const dir = dirname(routeFile);
  return (
    index.files.find(
      (file) =>
        pathMatchesPrefix(file, dir) &&
        /\.(service|guard|resolver)\.ts$/u.test(file) &&
        basename(file).includes(expected),
    ) ?? null
  );
}

function componentCompanionRefs(
  index: SourceIndex,
  file: string,
  includeModuleRoutes: boolean,
): SeedFileRef[] {
  const refs: SeedFileRef[] = [];
  const source = index.sources.get(file) ?? "";
  for (const template of decoratorStringUrls(source, "templateUrl")) {
    addExistingRef(index, refs, resolveRelativeFile(file, template), "template");
  }
  for (const style of [
    ...decoratorStringUrls(source, "styleUrl"),
    ...decoratorArrayUrls(source, "styleUrls"),
  ]) {
    addExistingRef(index, refs, resolveRelativeFile(file, style), "style");
  }

  for (const base of companionBases(file)) {
    for (const suffix of companionSuffixes) {
      const candidate = `${base}${suffix}`;
      const reason = companionReason(candidate);
      if (
        !includeModuleRoutes &&
        ["lazy route declaration", "route declaration"].includes(reason)
      ) {
        continue;
      }
      addExistingRef(index, refs, candidate, reason);
    }
  }
  return uniqueFileRefs(refs);
}

function semanticCompanionRefs(index: SourceIndex, file: string): SeedFileRef[] {
  const refs: SeedFileRef[] = [];
  for (const base of companionBases(file)) {
    for (const suffix of [
      ".spec.ts",
      ".test.ts",
      ".spec.tsx",
      ".test.tsx",
      ".model.ts",
      ".models.ts",
      ".type.ts",
      ".types.ts",
      ".const.ts",
      ".consts.ts",
      ".constant.ts",
      ".constants.ts",
      ".enum.ts",
      ".schema.ts",
      ".validator.ts",
    ]) {
      addExistingRef(index, refs, `${base}${suffix}`, companionReason(`${base}${suffix}`));
    }
  }
  return uniqueFileRefs(refs);
}

function companionBases(file: string): string[] {
  const typedBase = file.replace(/\.ts$/u, "");
  const roleBase = file.replace(
    /\.(page|component|service|guard|resolver|directive|pipe|module)\.ts$/u,
    "",
  );
  return uniqueSorted([typedBase, roleBase]);
}

function companionReason(path: string): string {
  if (/\.(spec|test)\.tsx?$/u.test(path)) {
    return "test";
  }
  if (/\.(html)$/u.test(path)) {
    return "template";
  }
  if (/\.(scss|sass|css|less)$/u.test(path)) {
    return "style";
  }
  if (path.endsWith("-routing.module.ts") || path.endsWith(".routes.ts")) {
    return "route declaration";
  }
  if (path.endsWith(".module.ts")) {
    return "feature module";
  }
  if (path.endsWith(".service.ts")) {
    return "feature service";
  }
  return "companion";
}

function addExistingRef(
  index: SourceIndex,
  refs: SeedFileRef[],
  path: string | null,
  reason: string,
): void {
  if (path !== null && index.fileSet.has(path)) {
    refs.push({ path, reason });
  }
}

function resolveRelativeFile(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  return normalize(join(dirname(fromFile), specifier));
}

function associatedTests(index: SourceIndex, files: string[]): SeedTestRef[] {
  const refs = new Set(
    files.flatMap((file) =>
      [...componentCompanionRefs(index, file, true), ...semanticCompanionRefs(index, file)]
        .filter((ref) => isJsTestPath(ref.path))
        .map((ref) => ref.path),
    ),
  );
  return uniqueSorted([...refs]).map((path) => ({ path, command: index.info.testCommand ?? null }));
}

function featureLocalInjectedServices(index: SourceIndex, file: string): string[] {
  const source = index.sources.get(file) ?? "";
  const imports = importIndex(index, file, source);
  const serviceSymbols = uniqueSorted([
    ...constructorTypeSymbols(source),
    ...injectCallSymbols(source),
  ]).filter((symbol) =>
    /(?:Service|Store|Repository|Client|Api|Analytics|Experiment)$/u.test(symbol),
  );
  return uniqueSorted(
    serviceSymbols.flatMap((symbol) => {
      const binding = imports.symbols.get(symbol);
      const resolved = binding?.resolvedPath;
      if (
        resolved !== undefined &&
        resolved !== null &&
        resolved.endsWith(".service.ts") &&
        isFeatureLocal(file, resolved)
      ) {
        return [resolved];
      }
      return [];
    }),
  );
}

function directLocalImportRefs(index: SourceIndex, file: string): SeedFileRef[] {
  const imports = importIndex(index, file, index.sources.get(file) ?? "");
  return uniqueFileRefs(
    [...imports.symbols.values()]
      .flatMap((binding) => {
        const resolved = binding.resolvedPath;
        return resolved !== null &&
          resolved !== file &&
          isFeatureLocal(file, resolved) &&
          !isBroadSharedPath(resolved)
          ? [{ path: resolved, reason: "local import" }]
          : [];
      })
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  );
}

function isFeatureLocal(owner: string, candidate: string): boolean {
  const ownerDir = dirname(owner);
  const candidateDir = dirname(candidate);
  return (
    candidateDir === ownerDir ||
    pathMatchesPrefix(candidateDir, ownerDir) ||
    pathMatchesPrefix(ownerDir, candidateDir.replace(/\/services$/u, ""))
  );
}

function isBroadSharedPath(path: string): boolean {
  return /(^|\/)(shared|services|components|lib|core)(\/|$)/u.test(path);
}

function modalCallers(index: SourceIndex): Map<string, SeedFileRef[]> {
  const callers = new Map<string, SeedFileRef[]>();
  for (const file of index.files.filter(
    (candidate) => candidate.endsWith(".ts") && !isJsTestPath(candidate),
  )) {
    const source = index.sources.get(file) ?? "";
    const imports = importIndex(index, file, source);
    const optionComponents = staticOptionComponents(source);
    for (const symbol of modalComponentSymbols(source, optionComponents)) {
      const binding = imports.symbols.get(symbol);
      const resolved = binding?.resolvedPath;
      if (resolved !== undefined && resolved !== null) {
        addMapList(callers, resolved, { path: file, reason: `creates modal ${symbol}` });
      }
    }
  }
  for (const [path, refs] of callers) {
    callers.set(path, uniqueFileRefs(refs));
  }
  return callers;
}

function staticOptionComponents(source: string): Map<string, string> {
  const options = new Map<string, string>();
  const sanitized = maskComments(source);
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*\{/gu;
  for (const match of sanitized.matchAll(pattern)) {
    const name = match[1];
    const start = sanitized.indexOf("{", match.index);
    if (name === undefined || start === -1) {
      continue;
    }
    const object = readBalanced(sanitized, start, "{", "}");
    const component = topLevelSymbolProp(object ?? "", "component");
    if (component !== null) {
      options.set(name, component);
    }
  }
  return options;
}

function modalComponentSymbols(source: string, optionComponents: Map<string, string>): string[] {
  const symbols: string[] = [];
  const sanitized = maskComments(source);
  for (const match of sanitized.matchAll(
    /\.(?:create|createPopover)\s*\(\s*(\{|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/gu,
  )) {
    const argumentStart = match.index + match[0].lastIndexOf(match[1] ?? "");
    const token = match[1];
    if (token === "{") {
      const object = readBalanced(sanitized, argumentStart, "{", "}");
      const component = topLevelSymbolProp(object ?? "", "component");
      if (component !== null) {
        symbols.push(component);
      }
    } else if (token !== undefined) {
      const name = readIdentifier(sanitized, argumentStart);
      const component = name === null ? undefined : optionComponents.get(name);
      if (component !== undefined) {
        symbols.push(component);
      }
    }
  }
  return uniqueSorted(symbols);
}

function modalContextRefs(index: SourceIndex, entryPath: string): SeedFileRef[] {
  const source = index.sources.get(entryPath) ?? "";
  const imports = importIndex(index, entryPath, source);
  return uniqueFileRefs(
    modalComponentSymbols(source, staticOptionComponents(source)).flatMap((symbol) => {
      const resolved = imports.symbols.get(symbol)?.resolvedPath;
      return resolved === undefined || resolved === null
        ? []
        : [{ path: resolved, reason: `modal ${symbol}` }];
    }),
  );
}

function isModalComponent(index: SourceIndex, file: string): boolean {
  if (modalNamePattern.test(basename(file)) || index.modalCallers.has(file)) {
    return true;
  }
  const htmlRefs = componentCompanionRefs(index, file, false).filter(
    (ref) => ref.reason === "template",
  );
  return htmlRefs.some((ref) => /<ion-(modal|popover)\b/iu.test(index.sources.get(ref.path) ?? ""));
}

function isShellComponent(file: string): boolean {
  return /(^|\/)(app|main|layout|shell)\.(page|component)\.ts$/u.test(file);
}

function angularRole(index: SourceIndex, file: string): AngularRole | null {
  const source = index.sources.get(file) ?? "";
  const lowerFile = file.toLowerCase();
  if (isGuardFile(index, file, source)) {
    return {
      source: "guard",
      label: "guard",
      kind: "service",
      tags: ["guard"],
      trustBoundaries: ["auth", "permissions", "user-input"],
    };
  }
  if (isResolverFile(index, file, source)) {
    return {
      source: "resolver",
      label: "resolver",
      kind: "service",
      tags: ["resolver"],
      trustBoundaries: ["network", "serialization"],
    };
  }
  if (isDirectiveFile(source, file)) {
    return {
      source: "directive",
      label: "directive",
      kind: "ui-flow",
      tags: ["directive"],
      trustBoundaries: ["user-input"],
    };
  }
  if (isPipeFile(source, file)) {
    return {
      source: "pipe",
      label: "pipe",
      kind: "ui-flow",
      tags: ["pipe"],
      trustBoundaries: ["serialization"],
    };
  }
  if (lowerFile.endsWith(".service.ts") || /@Injectable\s*\(/u.test(source)) {
    return serviceRole(file, source);
  }
  return null;
}

function serviceRole(file: string, source: string): AngularRole {
  const evidence = `${file}\n${source}`;
  if (
    /growthbook|remote[-_ ]?config|feature[-_ ]?flag|experiment|firebase.*remoteconfig/iu.test(
      evidence,
    )
  ) {
    return {
      source: "experiment",
      label: "experiment",
      kind: "service",
      tags: ["experiment"],
      trustBoundaries: ["network", "external-api", "serialization"],
    };
  }
  if (/mixpanel|clevertap|analytics|sentry|branch|tracking|trackEvent|logEvent/iu.test(evidence)) {
    return {
      source: "analytics-service",
      label: "analytics service",
      kind: "service",
      tags: ["analytics"],
      trustBoundaries: ["network", "external-api", "serialization"],
    };
  }
  if (
    /IonicStorageModule|Storage\b|Preferences|Filesystem|localStorage|sessionStorage|indexedDB|Cookie|cookies?/u.test(
      evidence,
    )
  ) {
    return {
      source: "storage-service",
      label: "storage service",
      kind: "service",
      tags: ["storage"],
      trustBoundaries: ["filesystem", "serialization", "secrets"],
    };
  }
  if (
    /HttpClient|AngularFire|@angular\/fire|firebase|@capacitor\/network|fetch\(|axios|GraphQL|Apollo/iu.test(
      evidence,
    )
  ) {
    return {
      source: "api-service",
      label: "API service",
      kind: "service",
      tags: ["api"],
      trustBoundaries: ["network", "external-api", "serialization"],
    };
  }
  return {
    source: "service",
    label: "service",
    kind: "service",
    tags: ["service"],
    trustBoundaries: ["network", "serialization"],
  };
}

function isGuardFile(index: SourceIndex, file: string, source: string): boolean {
  return (
    file.endsWith(".guard.ts") ||
    index.routeReferencedGuards.has(file) ||
    /\b(CanActivate|CanActivateChild|CanDeactivate|CanLoad|CanMatch|CanActivateFn|CanActivateChildFn|CanDeactivateFn|CanLoadFn|CanMatchFn)\b/u.test(
      source,
    )
  );
}

function isResolverFile(index: SourceIndex, file: string, source: string): boolean {
  return (
    file.endsWith(".resolver.ts") ||
    index.routeReferencedResolvers.has(file) ||
    /\b(Resolve|ResolveFn)\b/u.test(source)
  );
}

function isDirectiveFile(source: string, file: string): boolean {
  return file.endsWith(".directive.ts") || /@Directive\s*\(/u.test(source);
}

function isPipeFile(source: string, file: string): boolean {
  return file.endsWith(".pipe.ts") || /@Pipe\s*\(/u.test(source);
}

function hasRoleDecoratorOrImport(index: SourceIndex, file: string, role: AngularRole): boolean {
  const source = index.sources.get(file) ?? "";
  if (role.source === "directive") {
    return /@Directive\s*\(/u.test(source);
  }
  if (role.source === "pipe") {
    return /@Pipe\s*\(/u.test(source);
  }
  if (role.source === "guard") {
    return isGuardFile(index, file, source);
  }
  if (role.source === "resolver") {
    return isResolverFile(index, file, source);
  }
  return /@Injectable\s*\(/u.test(source) || file.endsWith(".service.ts");
}

function routeTrustBoundaries(route: ResolvedRoute): TrustBoundary[] {
  const boundaries: TrustBoundary[] = ["user-input"];
  if (route.context.guards.length > 0) {
    boundaries.push("auth", "permissions");
  }
  if (route.context.resolvers.length > 0 || route.context.lazyTargets.length > 0) {
    boundaries.push("network");
  }
  if (
    route.routePath.includes(":") ||
    route.routePath.includes("*") ||
    route.context.data.length > 0 ||
    route.context.resolvers.length > 0
  ) {
    boundaries.push("serialization");
  }
  return uniqueTrustBoundaries(boundaries);
}

function mergeRouteRecords(routes: ResolvedRoute[]): ResolvedRoute[] {
  const byKey = new Map<string, ResolvedRoute>();
  for (const route of routes.toSorted(routeRecordCompare)) {
    const key = `${route.routePath}:${route.entryPath}`;
    const previous = byKey.get(key);
    if (previous === undefined) {
      byKey.set(key, {
        ...route,
        context: sortRouteContext(route.context),
        summaryParts: uniqueSorted(route.summaryParts),
      });
      continue;
    }
    previous.context = sortRouteContext(mergeRouteContext(previous.context, route.context));
    previous.summaryParts = uniqueSorted([...previous.summaryParts, ...route.summaryParts]);
    previous.confidence = higherConfidence(previous.confidence, route.confidence);
  }
  return [...byKey.values()].toSorted(routeRecordCompare);
}

function routeRecordCompare(left: ResolvedRoute, right: ResolvedRoute): number {
  return (
    left.routePath.localeCompare(right.routePath) || left.entryPath.localeCompare(right.entryPath)
  );
}

function sortRouteContext(context: RouteContext): RouteContext {
  return {
    declarations: uniqueFileRefs(context.declarations),
    lazyTargets: uniqueFileRefs(context.lazyTargets),
    guards: uniqueSymbolRefs(context.guards),
    resolvers: uniqueSymbolRefs(context.resolvers),
    data: uniqueDataEntries(context.data),
    titles: uniqueSorted(context.titles),
    redirects: uniqueSorted(context.redirects),
    outlets: uniqueSorted(context.outlets),
    providers: uniqueSorted(context.providers),
  };
}

function firstDeclaration(context: RouteContext): string {
  return context.declarations[0]?.path ?? context.lazyTargets[0]?.path ?? "";
}

function isRedirectOnly(route: ParsedRoute): boolean {
  return (
    route.redirectTo !== null &&
    route.component === null &&
    route.loadComponent === null &&
    route.loadChildren === null &&
    route.children.length === 0
  );
}

function isBehavioralRedirect(route: ParsedRoute): boolean {
  return (
    isRedirectOnly(route) &&
    (route.guards.length > 0 || route.resolvers.length > 0 || route.data.length > 0)
  );
}

function redirectTargetPath(parentPath: string, redirectTo: string | null): string | null {
  if (redirectTo === null || redirectTo.startsWith("/") || redirectTo.includes("*")) {
    return null;
  }
  return composeRoute(parentPath, redirectTo, null);
}

function composeRoute(parent: string, child: string | null, matcher: string | null): string {
  if (matcher !== null && child === null) {
    return normalizeRoute(`${parent}/${matcher}`);
  }
  const segment = child ?? "";
  if (segment === "**") {
    return parent === "" || parent === "/" ? "/*" : `${parent}/*`;
  }
  if (segment.startsWith("/")) {
    return normalizeRoute(segment);
  }
  const segments = [parent, segment].filter((part) => part.length > 0 && part !== "/");
  return normalizeRoute(`/${segments.join("/")}`);
}

function normalizeRoute(route: string): string {
  const normalized = route.replace(/\/+/gu, "/").replace(/\/$/u, "");
  return normalized.length === 0 ? "/" : normalized;
}

function topLevelArrayItems(arraySource: string): string[] {
  const source = arraySource.trim();
  if (!source.startsWith("[") || !source.endsWith("]")) {
    return [];
  }
  const body = source.slice(1, -1);
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
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
    } else if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      items.push(body.slice(start, index));
      start = index + 1;
    }
  }
  const final = body.slice(start);
  if (final.trim().length > 0) {
    items.push(final);
  }
  return items;
}

function topLevelStringProp(source: string, name: string): string | null {
  const value = topLevelPropSource(source, name);
  const match = /^["'`]([^"'`]*)["'`]$/u.exec(value?.trim() ?? "");
  return match?.[1] ?? null;
}

function topLevelSymbolProp(source: string, name: string): string | null {
  const value = topLevelPropSource(source, name)?.trim();
  if (value === undefined) {
    return null;
  }
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)$/u.exec(value);
  return match?.[1] ?? null;
}

function topLevelArrayProp(source: string, name: string): string | null {
  const value = topLevelPropSource(source, name)?.trim();
  return value?.startsWith("[") === true ? value : null;
}

function topLevelPropSource(source: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(name)}\\s*:`, "gu");
  for (const match of source.matchAll(pattern)) {
    const colon = match.index + match[0].length;
    const propOffset = match[0].lastIndexOf(name);
    const nameIndex = match.index + (propOffset === -1 ? 0 : propOffset);
    if (!isTopLevel(source, nameIndex)) {
      continue;
    }
    return readValue(source, skipWhitespace(source, colon));
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
  return readExpressionValue(source, start);
}

function readExpressionValue(source: string, start: number): string {
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
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
    } else if (char === "}") {
      if (depth === 0) {
        return source.slice(start, index).trim();
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return source.slice(start, index).trim();
    }
  }
  return source.slice(start).trim();
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

function lazyImport(source: string | null): LazyImport | null {
  const value = source?.trim();
  if (value === undefined || value.length === 0) {
    return null;
  }
  const dynamic =
    /import\(\s*["']([^"']+)["']\s*\)(?:\s*\.then\s*\(\s*(?:\(?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)?\s*=>\s*\2\.([A-Za-z_$][A-Za-z0-9_$]*)|[^)]*?\.([A-Za-z_$][A-Za-z0-9_$]*)))?/su.exec(
      value,
    );
  if (dynamic?.[1] !== undefined) {
    return {
      specifier: dynamic[1],
      symbol: dynamic[3] ?? dynamic[4] ?? null,
      legacy: false,
    };
  }
  const legacy = /^["']([^"'#]+)#([A-Za-z_$][A-Za-z0-9_$]*)["']$/u.exec(value);
  if (legacy?.[1] !== undefined) {
    return { specifier: legacy[1], symbol: legacy[2] ?? null, legacy: true };
  }
  return null;
}

function symbolRefs(field: string, source: string | null): RouteSymbolRef[] {
  return symbolList(source).map((symbol) => ({ field, symbol, path: null }));
}

function resolverRefs(source: string | null): RouteSymbolRef[] {
  if (source === null) {
    return [];
  }
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) {
    return objectEntries(trimmed)
      .flatMap((entry) => (entry.value === null ? [] : [entry.value]))
      .filter((value) => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value))
      .map((symbol) => ({ field: "resolve", symbol, path: null }));
  }
  return symbolRefs("resolve", source);
}

function symbolList(source: string | null): string[] {
  if (source === null) {
    return [];
  }
  const trimmed = source.trim();
  if (trimmed.startsWith("[")) {
    return topLevelArrayItems(trimmed).flatMap((item) => {
      const symbol = /^([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(item.trim())?.[1];
      return symbol === undefined ? [] : [symbol];
    });
  }
  const symbol = /^([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(trimmed)?.[1];
  return symbol === undefined ? [] : [symbol];
}

function objectEntries(source: string | null): DataEntry[] {
  if (source === null || !source.trim().startsWith("{")) {
    return [];
  }
  const body = source.trim().slice(1, -1);
  const entries: DataEntry[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    cursor = skipWhitespaceAndCommas(body, cursor);
    const keyMatch = /^(?:["']([^"']+)["']|([A-Za-z_$][A-Za-z0-9_$]*))\s*:/u.exec(
      body.slice(cursor),
    );
    if (keyMatch === null) {
      break;
    }
    const key = keyMatch[1] ?? keyMatch[2];
    if (key === undefined) {
      break;
    }
    const valueStart = skipWhitespace(body, cursor + keyMatch[0].length);
    const value = readValue(body, valueStart);
    entries.push({ key, value: literalSummary(value) });
    cursor = valueStart + (value?.length ?? 0) + 1;
  }
  return entries;
}

function literalSummary(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  const stringMatch = /^["'`]([^"'`]*)["'`]$/u.exec(trimmed);
  if (stringMatch?.[1] !== undefined) {
    return stringMatch[1];
  }
  if (/^(true|false|null|[0-9]+(?:\.[0-9]+)?)$/u.test(trimmed)) {
    return trimmed;
  }
  const symbol = /^([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(trimmed)?.[1];
  return symbol ?? null;
}

function decoratorStringUrls(source: string, prop: string): string[] {
  const value = topLevelPropSourceInDecorator(source, prop);
  const literal = topLevelStringLiteral(value);
  return literal === null ? [] : [literal];
}

function decoratorArrayUrls(source: string, prop: string): string[] {
  const value = topLevelPropSourceInDecorator(source, prop);
  if (value === null || !value.trim().startsWith("[")) {
    return [];
  }
  return topLevelArrayItems(value).flatMap((item) => {
    const literal = topLevelStringLiteral(item.trim());
    return literal === null ? [] : [literal];
  });
}

function topLevelPropSourceInDecorator(source: string, prop: string): string | null {
  const sanitized = maskComments(source);
  const decorator = /@Component\s*\(\s*\{/u.exec(sanitized);
  if (decorator === null) {
    return null;
  }
  const objectStart = sanitized.indexOf("{", decorator.index);
  const object = objectStart === -1 ? null : readBalanced(sanitized, objectStart, "{", "}");
  return object === null ? null : topLevelPropSource(object, prop);
}

function topLevelStringLiteral(value: string | null): string | null {
  const match = /^["'`]([^"'`]*)["'`]$/u.exec(value?.trim() ?? "");
  return match?.[1] ?? null;
}

function constructorTypeSymbols(source: string): string[] {
  const symbols: string[] = [];
  const sanitized = maskComments(source);
  for (const match of sanitized.matchAll(/constructor\s*\(([^)]*)\)/gu)) {
    for (const param of (match[1] ?? "").split(",")) {
      const symbol = /:\s*([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(param)?.[1];
      if (symbol !== undefined) {
        symbols.push(symbol);
      }
    }
  }
  return uniqueSorted(symbols);
}

function injectCallSymbols(source: string): string[] {
  return uniqueSorted(
    [...maskComments(source).matchAll(/\binject\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/gu)]
      .map((match) => match[1])
      .filter((symbol): symbol is string => symbol !== undefined),
  );
}

function isAngularComponent(index: SourceIndex, file: string): boolean {
  const source = index.sources.get(file) ?? "";
  return (
    /\.(page|component)\.ts$/u.test(file) ||
    /@Component\s*\(/u.test(source) ||
    /from\s+["']@angular\/core["']/u.test(source)
  );
}

function hasDecorator(index: SourceIndex, file: string, decorator: string): boolean {
  return new RegExp(`@${decorator}\\s*\\(`, "u").test(index.sources.get(file) ?? "");
}

function exportedSymbolName(index: SourceIndex, file: string): string | null {
  const source = index.sources.get(file) ?? "";
  return (
    /\bexport\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(source)?.[1] ??
    /\bexport\s+(?:const|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(source)?.[1] ??
    null
  );
}

function fileExportsSymbol(source: string, symbol: string): boolean {
  return new RegExp(
    `\\b(?:export\\s+)?(?:class|function|const|let|var|interface|type|enum)\\s+${escapeRegExp(
      symbol,
    )}\\b`,
    "u",
  ).test(source);
}

function isPackageImport(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("src/") && !specifier.includes("/");
}

function splitNamespaceSymbol(symbol: string): [string, string | null] {
  const [base, member] = symbol.split(".");
  return [base ?? symbol, member ?? null];
}

function maskComments(source: string): string {
  let output = "";
  let index = 0;
  let quote: string | null = null;
  let escaped = false;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        output += "  ";
        index += 2;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function stripJsonComments(source: string): string {
  return maskComments(source).replace(/,\s*([}\]])/gu, "$1");
}

function readIdentifier(source: string, start: number): string | null {
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(skipWhitespace(source, start)));
  return match?.[0] ?? null;
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (/\s/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function skipWhitespaceAndCommas(source: string, index: number): number {
  let cursor = index;
  while (/[\s,]/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function groupsByFile(groups: RouteGroup[]): Map<string, RouteGroup[]> {
  const map = new Map<string, RouteGroup[]>();
  for (const group of groups) {
    addMapList(map, group.file, group);
  }
  return map;
}

function addMapList<T>(map: Map<string, T[]>, key: string, value: T): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function mergeSeeds(seeds: FeatureSeed[]): FeatureSeed[] {
  const byKey = new Map<string, FeatureSeed>();
  for (const seed of seeds.toSorted(seedCompare)) {
    const key =
      seed.identityKey ??
      `${seed.kind}:${seed.source}:${seed.entryPath}:${seed.route ?? seed.symbol ?? ""}`;
    const previous = byKey.get(key);
    if (previous === undefined) {
      byKey.set(key, {
        ...seed,
        ownedFiles: uniqueFileRefs(
          seed.ownedFiles ?? [{ path: seed.entryPath, reason: "entrypoint" }],
        ),
        contextFiles: uniqueFileRefs(seed.contextFiles ?? []),
        tests: uniqueTests(seed.tests ?? []),
        tags: uniqueSorted(seed.tags),
        trustBoundaries: uniqueTrustBoundaries(seed.trustBoundaries),
      });
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
    previous.tags = uniqueSorted([...previous.tags, ...seed.tags]);
    previous.trustBoundaries = uniqueTrustBoundaries([
      ...previous.trustBoundaries,
      ...seed.trustBoundaries,
    ]);
    previous.confidence = higherConfidence(previous.confidence, seed.confidence);
  }
  return [...byKey.values()].toSorted(seedCompare);
}

function seedCompare(left: FeatureSeed, right: FeatureSeed): number {
  return (
    left.source.localeCompare(right.source) ||
    left.entryPath.localeCompare(right.entryPath) ||
    (left.route ?? "").localeCompare(right.route ?? "") ||
    left.title.localeCompare(right.title)
  );
}

function uniqueFileRefs(refs: SeedFileRef[]): SeedFileRef[] {
  const byPath = new Map<string, SeedFileRef>();
  for (const ref of refs) {
    const previous = byPath.get(ref.path);
    if (previous === undefined || reasonRank(ref.reason) < reasonRank(previous.reason)) {
      byPath.set(ref.path, ref);
    }
  }
  return [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

function uniqueTests(tests: SeedTestRef[]): SeedTestRef[] {
  const byPath = new Map<string, SeedTestRef>();
  for (const test of tests) {
    byPath.set(test.path, test);
  }
  return [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

function uniqueSymbolRefs(refs: RouteSymbolRef[]): RouteSymbolRef[] {
  const byKey = new Map<string, RouteSymbolRef>();
  for (const ref of refs) {
    byKey.set(`${ref.field}:${ref.symbol}:${ref.path ?? ""}`, ref);
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      left.field.localeCompare(right.field) ||
      left.symbol.localeCompare(right.symbol) ||
      (left.path ?? "").localeCompare(right.path ?? ""),
  );
}

function uniqueDataEntries(entries: DataEntry[]): DataEntry[] {
  const byKey = new Map<string, DataEntry>();
  for (const entry of entries) {
    byKey.set(`${entry.key}:${entry.value ?? ""}`, entry);
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      left.key.localeCompare(right.key) || (left.value ?? "").localeCompare(right.value ?? ""),
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].toSorted();
}

function uniqueSortedByPath<T>(values: T[], path: (value: T) => string): T[] {
  const byPath = new Map<string, T>();
  for (const value of values) {
    byPath.set(path(value), value);
  }
  return [...byPath.values()].toSorted((left, right) => path(left).localeCompare(path(right)));
}

function uniqueTrustBoundaries(boundaries: TrustBoundary[]): TrustBoundary[] {
  const order: TrustBoundary[] = [
    "user-input",
    "auth",
    "permissions",
    "network",
    "external-api",
    "serialization",
    "filesystem",
    "database",
    "secrets",
    "process-exec",
    "concurrency",
  ];
  const set = new Set(boundaries);
  return order.filter((boundary) => set.has(boundary));
}

function higherConfidence(
  left: FeatureSeed["confidence"],
  right: FeatureSeed["confidence"],
): FeatureSeed["confidence"] {
  const rank = { low: 0, medium: 1, high: 2 };
  return rank[right] > rank[left] ? right : left;
}

function reasonRank(reason: string): number {
  const order = [
    "entrypoint",
    "route declaration",
    "lazy route target",
    "lazy route declaration",
    "template",
    "style",
    "test",
    "guard",
    "resolver",
    "route data",
    "feature service",
    "project context",
  ];
  const index = order.findIndex((entry) => reason.includes(entry));
  return index === -1 ? order.length : index;
}

function angularSeedTags(index: SourceIndex, extra: string[]): string[] {
  return uniqueSorted([
    "angular",
    ...index.info.tags,
    ...projectTags(index.info.project),
    ...extra,
  ]);
}

function isRouteFileCandidate(file: string): boolean {
  return routeFilePattern.test(file) || file.endsWith(".module.ts");
}

function isRootRouteFile(file: string): boolean {
  return /(^|\/)(app\.routes|app-routing\.module)\.ts$/u.test(file);
}

function isAngularSource(file: string): boolean {
  return (
    /\.(ts|tsx|html|scss|sass|css|less|json)$/u.test(file) &&
    !file.endsWith(".d.ts") &&
    !shouldSkip(file)
  );
}

function isJsTestPath(file: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(file);
}

function isProductionSourcePath(file: string): boolean {
  return !/(^|\/)(mocks?|fixtures?|__mocks__|__fixtures__|testing|test-harness)(\/|$)/iu.test(file);
}

function displayName(file: string): string {
  return basename(file)
    .replace(/\.(page|component|service|guard|resolver|directive|pipe)\.ts$/u, "")
    .replace(/\.ts$/u, "")
    .replace(/[-_]/gu, " ");
}

function symbolName(file: string): string {
  return basename(file)
    .replace(/\.(page|component|service|guard|resolver|directive|pipe)\.ts$/u, "")
    .replace(/\.ts$/u, "")
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase();
}

function tagForDependency(dep: string): string {
  if (dep.includes("ionic")) {
    return "ionic";
  }
  if (dep.includes("capacitor")) {
    return "capacitor";
  }
  if (dep === "@angular/fire") {
    return "angular-fire";
  }
  if (dep.includes("fire") || dep.includes("firebase")) {
    return "firebase";
  }
  if (dep.includes("karma")) {
    return "karma";
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
  if (file.includes("karma")) {
    return "karma";
  }
  if (file.includes("environment")) {
    return "environment";
  }
  return "angular";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? normalize(value) : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
