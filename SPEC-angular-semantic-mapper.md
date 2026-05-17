# Angular/Ionic Semantic Mapper Spec

## Purpose

Add a first-class Angular/Ionic semantic mapper that turns Angular applications
into reviewable Clawpatch `FeatureSeed` records. The mapper must help a review
agent reason about product behavior, not just list files. A high-quality route
feature should point at the page or lazy boundary that implements the user flow,
carry the route declaration and Angular context that changes behavior, and attach
nearby tests and companion files without sweeping in unrelated shared code.

This is the specification for the upstream-quality implementation. The current
PR branch already contains a first mapper pass in `src/mappers/angular.ts`; this
document is authoritative when that implementation disagrees with the target
behavior. This pass is spec-only and does not require changing mapper code.

## Codebase Context

Clawpatch mapping currently uses deterministic `FeatureSeed` mappers registered
from `src/mapper.ts`. Angular support should follow the existing mapper contract:

- Return root-relative paths only.
- Use stable `identityKey` values so existing feature records do not churn.
- Use existing feature kinds: `route`, `ui-flow`, `service`, `config`,
  `library`, and `test-suite` where relevant.
- Use existing trust boundaries from `src/types.ts`.
- Reuse project discovery from `src/mappers/projects.ts`, including workspace,
  Nx, package manager, source root, target command, and project tags.
- Reuse filesystem helpers from `src/mappers/shared.ts`, including `walk`,
  `normalize`, `pathMatchesPrefix`, and `shouldSkip`.
- Avoid generated output, `.clawpatch`, symlinked directories, and package
  manager build artifacts through the existing skip rules.

The local FINN-Web-App checkout used to ground this spec is an Angular/Ionic app
with Angular 17, Ionic, Capacitor, Firebase, AngularFire, route modules, lazy
loaded page modules, Ionic modal and popover flows, experiment services, and
environment-specific config. The observed checkout has dozens of routing files,
more than one hundred page files, nearly two hundred component files, and many
services, guards, directives, and pipes. The mapper must scale to this shape
without hard-coded caps or noisy duplicate features.

## Detection

Treat a Node project as Angular-related when any of these signals are present:

- Dependencies or dev dependencies: `@angular/core`, `@angular/router`,
  `@angular/cli`, `@angular/common`, `@angular/forms`, `@ionic/angular`,
  `@capacitor/core`, `@angular/fire`, `firebase`, `firebase-admin`.
- Project files: `angular.json`, `ionic.config.json`, `capacitor.config.ts`,
  `capacitor.config.js`, `capacitor.config.json`, `firebase.json`,
  `.firebaserc`, `karma.conf.js`, `tsconfig.app.json`, `tsconfig.spec.json`.
- Source signals: `src/app`, `main.ts`, `app.module.ts`, `app.config.ts`,
  `app.routes.ts`, `app-routing.module.ts`, `RouterModule.forRoot`,
  `RouterModule.forChild`, `provideRouter`, Angular decorators, Ionic imports,
  or Capacitor/Firebase bootstrap code.

Source roots should be discovered in this order:

1. Nx project `sourceRoot`.
2. `angular.json` project `sourceRoot` values.
3. TypeScript `include` globs from package-local `tsconfig*.json` when they are
   bounded under the project root.
4. Package-local `src`, `src/app`, and `app`.

Project tags should include the Angular platform signals that caused detection:
`angular`, `ionic`, `capacitor`, `firebase`, `angular-fire`, `karma`,
`project:<name>`, `project-root:<root>`, and Nx project type tags when present.

Detection must not rely on a single root package. It must work for monorepos
with `apps/*`, `packages/*`, workspace globs, and Nx `project.json` files.

## Feature Model

The mapper should emit semantic features that match Angular review units.

### Route Features

A route feature represents a user-addressable route or a lazy route boundary
when the leaf page cannot be resolved statically.

Use:

- `kind: "route"`
- `source: "angular-route"`
- `entryPath`: the resolved page/component file when known, otherwise the lazy
  module or route file that owns the boundary
- `route`: the canonical full route path
- `identityKey`: `angular:route:<projectRoot>:<routePath>:<entryPath>`
- `trustBoundaries`: include `user-input`, `auth`, `permissions`, `network`,
  and `serialization` when route context suggests those boundaries

Route features should own the primary implementation files for the route:

- route component or page `.ts`
- component/page template and styles
- route declaration files that directly define the route
- lazy module and lazy route files needed to understand the boundary
- feature-local page module files
- same-basename page/component tests

Route features should use context files for behavior that affects the route but
is independently reviewable:

- guards
- resolvers
- feature-local services that are injected by the page
- route-level config and data files
- relevant project context such as `package.json`, `angular.json`,
  `tsconfig*.json`, and `karma.conf.js`

Redirect-only routes should not create high-confidence route features unless
there is a real implementation entrypoint. Preserve redirect metadata by adding
the route declaration as context to the owning router/config feature or to the
target route when a static target can be resolved. If no target can be resolved,
emit a low-confidence config-style route feature only when the redirect contains
guards, route data, or other behavior worth reviewing.

### Pages And Components

Unrouted Angular pages and components should be mapped as `ui-flow` features.
Do not emit a generic page/component feature for a component that already backs
a route feature.

Use these sources:

- `angular-page-component` for `.page.ts` files that are not route-backed
- `angular-component` for general Angular components
- `angular-modal-component` for Ionic modal, popup, drawer, dialog, sheet,
  alert-like, or popover components
- `angular-shell-component` for app/root shell components such as
  `app.component.ts` and route layout components when they are not better
  represented as a route

Stable identities:

- `angular:component:<projectRoot>:<componentPath>`
- `angular:modal:<projectRoot>:<componentPath>`
- `angular:shell:<projectRoot>:<componentPath>`

Modal and popover detection must use both filename/decorator evidence and call
site evidence:

- filenames containing `modal`, `popup`, `dialog`, `drawer`, `sheet`,
  `popover`, `alert`, or `confirmation`
- `ModalController.create({ component: SomeComponent })`
- `PopoverController.create({ component: SomeComponent })`
- project wrapper services such as `PopoverService.createPopover(options)` when
  `options.component` is statically visible
- templates using `ion-modal`, `ion-popover`, or component selectors that are
  clearly modal shells

The modal feature should own the modal component and companions. Callers should
usually be context files, not owned files, unless the modal is nested inside a
feature directory and has only one owning page.

### Services

Services should be mapped as `service` features when they contain reviewable
business logic, external API logic, persistence, app state, analytics, or
cross-feature orchestration.

Use:

- `source: "angular-service"` for normal injectable services
- `source: "angular-api-service"` for services importing `HttpClient`, Firebase,
  AngularFire, Capacitor network APIs, or external SDK clients
- `source: "angular-storage-service"` for services using Ionic storage,
  Capacitor Preferences/FileSystem, browser storage, IndexedDB, or cookies
- `source: "angular-analytics-service"` for analytics, tracking, Sentry,
  Mixpanel, CleverTap, Firebase analytics, Branch, or similar telemetry
- `source: "angular-experiment"` for GrowthBook, Firebase Remote Config,
  feature flag, experiment, or remote-config services

Stable identity:

- `angular:service:<projectRoot>:<servicePath>`

Attach same-basename tests and narrow model/type/const companions. Feature-local
services may also appear as context on route/page features, but they should
remain their own feature when they are complex or shared by multiple pages.

### Guards And Resolvers

Guards and resolvers are `service` features because they encode route behavior.

Use:

- `source: "angular-guard"` for class and functional guards
- `source: "angular-resolver"` for class and functional resolvers
- `identityKey`: `angular:guard:<projectRoot>:<guardPath>` or
  `angular:resolver:<projectRoot>:<resolverPath>`

Guard detection must cover:

- filenames ending in `.guard.ts`
- classes implementing or importing `CanActivate`, `CanActivateChild`,
  `CanDeactivate`, `CanLoad`, or `CanMatch`
- functional exports typed as `CanActivateFn`, `CanActivateChildFn`,
  `CanDeactivateFn`, `CanLoadFn`, or `CanMatchFn`
- route arrays that reference guard symbols from non-standard filenames, such as
  `country-guard.ts`

Resolver detection must cover:

- filenames ending in `.resolver.ts`
- classes implementing or importing `Resolve`
- functional exports typed as `ResolveFn`
- route `resolve: { key: ResolverSymbol }` declarations

Routes that reference guards or resolvers must include the resolved guard or
resolver file as context, with a reason that names the route field and symbol.
Do not use the route declaration file as a stand-in when the guard/resolver file
can be resolved.

### Directives And Pipes

Directives and pipes should be mapped when they are production declarations, not
test-only stubs.

Use:

- `source: "angular-directive"`
- `source: "angular-pipe"`
- `identityKey`: `angular:directive:<projectRoot>:<directivePath>` or
  `angular:pipe:<projectRoot>:<pipePath>`

Directives generally use `kind: "ui-flow"` because they alter user interaction.
Pipes can use `kind: "ui-flow"` when they affect presentation and
`kind: "library"` when they are pure data formatting helpers with no UI
coupling.

Exclude declarations found only in `*.spec.ts`, `*.test.ts`, mocks, fixtures,
and generated test harness files from feature output. Those files should attach
as tests or context to production features instead.

### Config And Bootstrap

Config features should represent Angular platform, mobile, Firebase, and build
configuration.

Use:

- `source: "angular-config"`
- `kind: "config"`
- `identityKey`: `angular:config:<projectRoot>:<configPath>` for single-file
  configs

Map these root and source config files when present:

- `angular.json`
- `ionic.config.json`
- `capacitor.config.ts`, `capacitor.config.js`, `capacitor.config.json`
- `firebase.json`
- `.firebaserc`
- `karma.conf.js`
- `tsconfig.json`, `tsconfig.app.json`, `tsconfig.spec.json`
- `main.ts`, `polyfills.ts`, `app.module.ts`, `app.config.ts`,
  `app.routes.ts`, and `app-routing.module.ts`
- `environment.ts`, `environment.*.ts`, and Angular file replacements from
  `angular.json`
- global style entrypoints from `angular.json`, such as `global.scss` and
  `theme/variables.scss`

Environment files should be grouped carefully. Prefer one environment config
feature rooted at the default `environment.ts` when replacements are declared,
with environment-specific files in `ownedFiles`. Do not create many noisy config
features for every environment variant unless they are not connected by
`angular.json`.

## Route Parsing Requirements

Route parsing is the most important part of the mapper. Use TypeScript-aware
parsing for source files where possible. If a small custom parser is retained,
it must tokenize comments, strings, template literals, object literals, arrays,
spreads, and nested expressions robustly enough to avoid fixed regex windows.

The parser must recognize route declarations in these forms:

- `export const routes: Routes = [...]`
- `const routes: Routes = [...]`
- `const routes = [...] satisfies Routes`
- `const routes = [...] as Routes`
- `RouterModule.forRoot(routes)`
- `RouterModule.forRoot([...])`
- `RouterModule.forChild(routes)`
- `RouterModule.forChild([...])`
- `provideRouter(routes)`
- `provideRouter([...])`
- `provideRoutes(routes)`
- route arrays exported from files named `*.routes.ts`

Route object fields to parse:

- `path`
- `matcher`
- `component`
- `loadComponent`
- `loadChildren`
- `children`
- `redirectTo`
- `pathMatch`
- `outlet`
- `title`
- `data`
- `resolve`
- `canActivate`
- `canActivateChild`
- `canDeactivate`
- `canLoad`
- `canMatch`
- `providers`

Canonical path requirements:

- Compose parent and child paths into a normalized path beginning with `/`.
- Preserve parameter segments such as `:id`.
- Preserve wildcard routes as `/*` or `<parent>/*`.
- Preserve empty child paths by keeping the parent path.
- Preserve auxiliary outlets in summary/context even if they are not encoded in
  the primary `route` field.
- Do not collapse lazy child module routes to `/`. A child route with `path: ""`
  in a module loaded at `/main/transactions` must map to `/main/transactions`,
  not `/`.
- Include the lazy parent path when a root route loads a module and that module
  defines its own `RouterModule.forChild` routes.

Entrypoint resolution requirements:

- Resolve `component` symbols through import declarations first, including
  aliased named imports.
- Resolve default imports and namespace imports where the symbol is statically
  clear.
- Resolve project absolute imports such as `src/app/...` using `baseUrl` and
  `paths` from `tsconfig*.json`.
- Resolve relative imports with standard TypeScript extension rules:
  `.ts`, `.tsx`, `.page.ts`, `.component.ts`, `.module.ts`, `.routes.ts`, and
  `index.ts`.
- Resolve re-export barrels from `index.ts` when they directly export the
  target symbol.
- Resolve `loadComponent: () => import("./x").then(m => m.XComponent)` to the
  component file.
- Resolve `loadChildren: () => import("./x/x.module").then(m => m.XModule)` to
  the lazy module, then find the paired route file or module route declaration.
- Resolve legacy string lazy routes such as `"./x/x.module#XModule"` when found.
- Use filename/kebab fallback only after import and TypeScript module
  resolution fail. Fallback matches must be local to the route or lazy module
  directory and should lower confidence.

Route graph requirements:

- Parse all route-bearing files first.
- Build a graph from root route declarations through lazy imports to child route
  declarations.
- Emit route features from the composed graph, not from each route file in
  isolation.
- Merge a lazy boundary route and its default child route when they share the
  same full path and resolve to the same page or module context.
- Keep separate route features when the same component is mounted at different
  route paths, because route guards, data, and params can change behavior.
- Preserve route `data` keys and simple literal values in summaries or context
  reasons, especially feature flags, query param handling, auth metadata, and
  experiment keys.
- Preserve guards/resolvers inherited from parent routes in child route
  context, including `canActivateChild`.
- Do not execute Angular CLI, app code, or build tooling during route parsing.

## Companion File Detection

Companion detection must be deterministic and narrow. It should combine Angular
decorator evidence, import evidence, same-basename conventions, and module
membership.

For route/page/component/modal features, attach:

- component/page `.ts`
- decorator `templateUrl`
- decorator `styleUrl`
- decorator `styleUrls`
- same-basename `.html`, `.scss`, `.sass`, `.css`, `.less`
- same-basename `.spec.ts`, `.test.ts`, `.spec.tsx`, and `.test.tsx`
- paired `.module.ts`, `-routing.module.ts`, `.routes.ts`
- same-basename `.model.ts`, `.models.ts`, `.type.ts`, `.types.ts`
- same-basename `.const.ts`, `.consts.ts`, `.constant.ts`, `.constants.ts`
- same-basename `.enum.ts`, `.schema.ts`, and `.validator.ts`
- feature-local services that share the same basename or are directly injected
  by the component constructor
- modal/popover components created by the page as context

For service, guard, resolver, directive, and pipe features, attach:

- same-basename tests
- same-basename models/types/constants/enums/schemas
- directly imported local files when they are in the same feature directory and
  are not broad shared infrastructure

Do not attach:

- entire `shared/`, `services/`, or `components/` directories
- all app-level services to every route
- specs as production feature entrypoints
- generated files or Clawpatch state
- build output under `www`, `dist`, `coverage`, or `android` generated outputs

If the same path is discovered for multiple reasons inside one feature, keep one
file ref with a deterministic reason. Prefer the most specific reason in this
order: `entrypoint`, `route declaration`, `lazy route target`, `template`,
`style`, `test`, `guard`, `resolver`, `route data`, `feature service`,
`project context`.

## Duplicate And Merge Semantics

The Angular mapper should perform mapper-local merging before the global
`dedupeSeeds` pass. Global dedupe is intentionally shallow and should not be
relied on for Angular route correctness.

Merge seeds when their `identityKey` values match. The merged seed must:

- keep the original title, summary, kind, source, entrypoint, route, command,
  and symbol unless a later duplicate has higher-confidence resolution
- union `ownedFiles` with stable path ordering
- union `contextFiles` with stable path ordering
- union `tests` by path
- union `tags` in deterministic order
- union `trustBoundaries` in deterministic order
- raise confidence only when the duplicate adds direct import/decorator evidence

Route-specific rules:

- Same route path and same entry path: merge.
- Same route path and different entry paths: keep separate only when both
  entrypoints are real implementations. Otherwise prefer the concrete
  component/page over the module or declaration file and keep the module as
  context.
- Same component mounted at different route paths: keep separate route features.
- Generic page/component seed for a route-backed component: suppress and merge
  companions into the route feature.
- Lazy parent route and default child route with the same path: merge into one
  feature with both declarations as owned or context files.
- Redirect-only duplicates: merge into route/config context, not into separate
  high-confidence route features.

Ordering must be stable across platforms. Sort paths with normal string
ordering after normalizing separators to `/`.

## Expected Output Quality

For a FINN-Web-App-shaped Angular/Ionic application, high-quality output means:

- Root app routes and nested lazy child routes produce full route paths, such as
  `/main/transactions`, rather than orphan paths like `/`.
- Route entrypoints point to concrete page/component files when statically
  discoverable, not just lazy modules.
- Lazy modules and routing modules appear as route context when the page is
  known.
- Guards and resolvers resolve to their implementation files and appear as both
  route context and standalone guard/resolver service features.
- Route `data` is visible enough for reviewers to notice query param handling,
  feature flags, auth hints, or experiment context.
- A component that backs a route is not duplicated as a generic page feature.
- Unrouted shared components, modals, popovers, directives, pipes, and services
  still become reviewable features when they have production behavior.
- Experiment and remote-config services are tagged distinctly from generic
  services.
- Environment, Firebase, Capacitor, Ionic, Angular build, and bootstrap config
  are represented without creating low-value duplicates.
- Nearby tests are attached when names and module locality make the relationship
  clear.
- The mapper returns all discovered seeds. It must not contain hidden
  `slice(0, N)` caps such as the historical 120-route/page cap.
- Output is deterministic: the same checkout maps to the same feature titles,
  paths, tags, tests, and identity keys across repeated runs.
- Confidence reflects evidence quality. Import/decorator resolution is high,
  local filename fallback is medium, and unresolved lazy/config-only features
  are low or medium depending on context.
- Feature titles are concise and meaningful, for example `Angular route
/main/transactions`, `Ionic modal bank list`, `Angular guard auth local`, or
  `Angular experiment membership pricing`.

The mapper should be broad enough to improve agent review coverage but narrow
enough that a feature remains reviewable. A feature that owns dozens of unrelated
shared services is worse than a smaller route feature with precise context.

## Test Fixture Strategy

Use focused Vitest fixtures with the existing `fixtureRoot`, `writeFixture`,
`detectProject`, `discoverNodeProjects`, and `mapFeatures` helpers. Do not copy
private application code into tests. Build synthetic fixtures that mirror the
important shapes.

Required fixture groups:

- Detection by dependency-only Angular package.
- Detection by `angular.json` with no Angular dependency in `package.json`.
- Monorepo/Nx Angular project with package-local source root and project test
  target.
- `RouterModule.forRoot(routes)` with root redirects, guards, route data, and
  lazy `loadChildren`.
- `RouterModule.forChild(routes)` in a lazy module and full parent path
  composition across the lazy boundary.
- Standalone `provideRouter(routes)` and `loadComponent`.
- Route arrays using `satisfies Routes`, `as Routes`, spreads of local arrays,
  comments, multiline dynamic imports, and nested child arrays.
- Empty child paths, params, wildcard routes, redirect-only routes, and
  `canActivateChild` inheritance.
- Import resolution with named aliases, default imports, `src/...` baseUrl
  imports, and direct `index.ts` barrel exports.
- Guard files with non-standard names referenced from route arrays.
- Functional guards and resolvers.
- Decorator `templateUrl`, `styleUrl`, and `styleUrls` companion files.
- Same-basename tests and feature-local services.
- Ionic modal/popover detection from filename and `ModalController.create`.
- Services with `HttpClient`, storage, analytics, Firebase, and experiment
  imports, each producing the expected source/tags/trust boundaries.
- Directives and pipes in production files, plus spec-only declarations that
  must not become features.
- Environment file replacement grouping from `angular.json`.
- More than 120 routes and more than 120 components returned without mapper
  truncation.
- Duplicate suppression for route-backed page components and lazy default
  children.

Small tests should assert exact entrypoints, route paths, selected owned files,
selected context files, tests, source, tags, trust boundaries, and absence of
known bad duplicates. Larger fixtures may assert counts and representative
features, but they should still check the specific behavior that guards against
regression.

Minimum pass-2 verification:

```bash
pnpm typecheck
pnpm test src/mapper.test.ts
```

Before marking the implementation PR ready, run:

```bash
pnpm format:check
pnpm lint
pnpm test
pnpm build
```

## Proposed Implementation Plan

1. Keep the current PR mapper as a starting point, but separate route discovery
   into parse, resolve, graph composition, and seed emission phases.
2. Add a TypeScript import/module resolver that understands project root,
   `baseUrl`, `paths`, relative imports, extension variants, and direct barrels.
3. Build a route graph across lazy module boundaries before emitting route
   seeds.
4. Replace broad basename matching with decorator-driven and resolver-driven
   companion detection, retaining conservative same-basename fallbacks.
5. Add standalone semantic passes for services, guards, resolvers, directives,
   pipes, modals/popovers, experiments, and config/bootstrap.
6. Add mapper-local merge logic for Angular route/component duplicates before
   returning seeds to `src/mapper.ts`.
7. Expand `src/mapper.test.ts` with the fixture groups above, keeping each test
   narrow enough to explain the behavior it protects.

## Known Limitations

The mapper is static. It should not execute Angular CLI, app bootstrap code, or
project scripts. Because of that, these cases can remain lower confidence or
unresolved:

- route arrays built through complex runtime expressions
- `router.resetConfig(...)` and routes fetched from network/config at runtime
- dynamic import paths built from variables or template expressions
- non-literal `path`, `redirectTo`, `data`, `providers`, guard, and resolver
  values
- external library routes where source is outside the repository
- deeply indirect barrel exports that require full TypeScript program analysis
- Angular compiler metadata not visible in source files
- auxiliary outlet behavior that cannot fit cleanly in the single `route` field
- templates that instantiate dynamic components through runtime component
  factories without static references
- route behavior determined entirely by DI providers with no local source signal

These limitations should be visible through medium or low confidence and clear
summaries. They should not cause silent omissions of ordinary Angular/Ionic
routes, pages, services, guards, resolvers, directives, pipes, modals, or config.
