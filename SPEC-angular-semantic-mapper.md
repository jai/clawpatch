# Angular/Ionic Semantic Mapper Spec

## Goal

Add a first-class Angular/Ionic mapper that produces semantic `FeatureSeed`
records for routes, pages, components, services, guards, resolvers, directives,
pipes, experiments, and Angular platform config. The mapper must be useful for
review agents, not just inventory: entrypoints should point at the real feature
implementation, companion files/tests should be attached, and route context
should preserve parent paths, guards, resolvers, and lazy boundaries.

This replaces the local POC behavior that found many files but was not
shippable because it used regex route windows, hidden `slice(0, 120)` caps,
filename-fuzzy component resolution, weak companion detection, no service/guard
context, and duplicate route/page records.

## Integration

- Add `src/mappers/angular.ts`.
- Register it in `src/mapper.ts` as `{ name: "angular", map: angularSeeds }`.
- Reuse existing mapper contracts: `FeatureSeed`, `MapperContext`, `walk`,
  `pathExists`, `normalize`, `projectTargetCommand`, `projectTags`, and
  package/project context helpers.
- Keep all paths root-relative and deterministic.
- Do not silently cap returned seeds. If future limits are needed, expose them as
  explicit configuration or diagnostics rather than truncating discovery.

## Project Detection

Treat a Node project as Angular-related when any package dependency or project
file indicates Angular, Ionic, Capacitor, AngularFire, or Firebase:

- Dependencies/dev dependencies: `@angular/core`, `@angular/router`,
  `@angular/cli`, `@ionic/angular`, `@capacitor/core`, `@angular/fire`,
  `firebase`, `firebase-admin`.
- Config files: `angular.json`, `ionic.config.json`, `capacitor.config.ts`,
  `capacitor.config.js`, `capacitor.config.json`, `firebase.json`,
  `.firebaserc`.
- Source signals: `src/app`, `app.routes.ts`, `app-routing.module.ts`,
  `RouterModule.forRoot`, `RouterModule.forChild`, `provideRouter`,
  Angular decorators, or Ionic page/component imports.

Source roots should prefer `angular.json` project `sourceRoot` values, then
fall back to package-local `src`, `src/app`, and the Node project root. Tags
should include detected platform signals such as `angular`, `ionic`,
`capacitor`, `firebase`, and `angular-fire`.

## Route Mapping

Scan route-bearing TypeScript files under detected source roots:

- `app.routes.ts`
- `*.routes.ts`
- `*routing*.ts`
- `*.module.ts` files containing `RouterModule.forRoot` or
  `RouterModule.forChild`
- files containing `provideRouter`

Parse route arrays with balanced object/array scanning rather than a fixed regex
window. The parser should tolerate strings, comments, nested objects, nested
children, guards, resolvers, and route `data`.

Recognize common route declarations:

- `export const routes: Routes = [...]`
- `const routes: Routes = [...]`
- `RouterModule.forRoot(routes)` and `RouterModule.forRoot([...])`
- `RouterModule.forChild(routes)` and `RouterModule.forChild([...])`
- `provideRouter(routes)` and `provideRouter([...])`

For each route object:

- Compose parent and child paths into a canonical route path.
- Preserve empty child paths, params, wildcard routes, redirects, and nested
  children.
- Resolve `component` symbols through import declarations, including aliased
  named imports.
- Resolve `loadComponent` dynamic imports to component files.
- Resolve `loadChildren` dynamic imports to lazy module or route files when
  possible.
- Attach route declaration files, lazy module files, guards, resolvers, and
  route `data` context.
- Use kebab-case filename matching only as a local fallback after import-based
  resolution fails.

## Semantic Units

Route-backed pages should emit one route feature per canonical route/component
or route/lazy target pair. Use routed features instead of also emitting generic
page features for the same component.

Use stable identity keys:

- `angular:route:<projectRoot>:<routePath>:<entryPath>`
- `angular:component:<projectRoot>:<componentPath>`
- `angular:service:<projectRoot>:<servicePath>`
- `angular:guard:<projectRoot>:<guardPath>`
- `angular:resolver:<projectRoot>:<resolverPath>`
- `angular:directive:<projectRoot>:<directivePath>`
- `angular:pipe:<projectRoot>:<pipePath>`
- `angular:config:<projectRoot>:<configPath>`
- `angular:experiment:<projectRoot>:<experimentPath>`

When the same route/component is discovered more than once, merge owned files,
context files, tests, tags, and trust boundaries. When the same component is
mounted at different route paths, keep separate route features because behavior
can differ by route context.

## Companion Files And Tests

Attach companions deterministically. For route/page/component features include:

- route declaration files and routing modules
- component/page `.ts`
- decorator `templateUrl`, `styleUrl`, and `styleUrls`
- same-basename `.html`, `.scss`, `.sass`, `.css`, `.less`
- same-basename `.spec.ts`
- nearby `.module.ts`, `-routing.module.ts`, `.routes.ts`
- same-basename `.model.ts`, `.models.ts`, `.types.ts`
- same-basename `.const.ts`, `.consts.ts`, `.constants.ts`
- component/page-specific service files and service specs

For service, guard, resolver, directive, and pipe features, attach same-basename
specs and tightly related model/const/type files. Avoid sweeping entire shared
directories into every seed.

## Breadth

Map these Angular concepts:

- Routes and routed pages/components.
- Unrouted Angular components with `@Component`.
- Services from `@Injectable`, `.service.ts`, and service specs.
- Guards from guard filenames, class guards, and functional guard exports such
  as `CanActivateFn`, `CanMatchFn`, and `CanDeactivateFn`.
- Resolvers from resolver filenames, class resolvers, and `ResolveFn`.
- Directives from `@Directive`.
- Pipes from `@Pipe`.
- Experiments/feature flags from names like `experiment`, `feature-flag`,
  `featureFlags`, `remote-config`, and Firebase Remote Config usage.
- Shared config from `angular.json`, `app.config.ts`, `main.ts`,
  `environment*.ts`, `ionic.config.json`, `capacitor.config.*`,
  `firebase.json`, and `.firebaserc`.

## Tests

Add focused tests using existing `fixtureRoot`, `writeFixture`, `detectProject`,
and `mapFeatures` helpers. Cover:

- Angular detection by dependencies and `angular.json`.
- Route parsing for route literals, `RouterModule.forRoot`,
  `RouterModule.forChild`, and `provideRouter`.
- Parent/child path composition, empty child paths, params, wildcard routes, and
  redirects.
- Import and alias-based component resolution.
- `loadComponent` and `loadChildren` dynamic imports.
- Guards, resolvers, and route `data` context.
- Decorator and same-basename companion files.
- Services, guards, resolvers, directives, pipes, experiments, and config seeds.
- Dedupe of route/page records into one semantic feature.
- More than 120 routes are returned without mapper-local truncation.

## Verification

Run, at minimum:

```bash
pnpm typecheck
pnpm test src/mapper.test.ts
```

Before marking the PR ready, also run:

```bash
pnpm format:check
pnpm lint
pnpm test
pnpm build
```

