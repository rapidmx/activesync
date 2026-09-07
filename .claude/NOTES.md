# activesync — Design Decisions & Session Notes

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Standing design decisions & constraints

- **Vulnerability/review threat model: externally-exploitable only.** Only count issues reachable
  from a downstream, untrusted HTTP client hitting a service built on this package (anonymous or
  low-privilege caller). Do NOT flag developer-only footguns or purely theoretical races with no
  concrete external trigger path.
- **Commit discipline.** Don't `git commit` unless explicitly asked, even after a full
  review-and-fix cycle with passing tests. Leave changes staged/unstaged and say so.
- **Commit message style: concise, one line per task/bug/feature — no verbose prose.** A commit
  message is a short list of one-line bullets, one per item. This mirrors JP's standing convention
  across his other repos.

## Session Log

### 2026-09-06 — Repo split: `@rapidrest/mail` → four RapidMX packages

- **This repo is `@rapidmx/activesync`**, carved out of the former monolith `@rapidrest/mail`
  (`d:\github\rapidrest\mail`, still present there for reference/history) — was `src/eas`/`test/eas`
  there, moved to this repo's own root (not nested under an `eas/` folder).
- Depends on [`@rapidmx/restapi`](https://github.com/RapidMX/restapi) for the mailbox/folder/message/
  contact/calendar/task models, `resolveCallerMailboxUid`/`RecoverableRepoUtils`/`sendComposedMime`
  REST-layer helpers, `BlobStore`, and the scan pipeline. Originally linked locally via Yarn Berry's
  `portal:../restapi`; switched to the real published `^0.1.0` once JP published it to npm - see the
  very next bullet for exactly why the portal approach was a real problem, not just a temporary
  convenience.
- **Mechanical migration gotcha** (same one hit in the `autodiscover` split, see that repo's notes
  for the fuller writeup): several distinct old import targets collapse onto the same new
  `@rapidmx/restapi` specifier, producing duplicate-import lint errors that needed hand-merging in
  `test/testDoubles.ts` and a few `src/commands/*.ts` files.
- **Real bug found and fixed: `vitest.config.ts`'s `ssr.noExternal` must list `@rapidmx/restapi`
  too, not just `@rapidrest/service-core`/`@rapidrest/core`.** Without it, Vite's SSR pipeline
  bundles/transforms the framework packages for the test file's own direct imports but treats
  `@rapidmx/restapi` as external (untransformed, natively `require`d) - producing TWO separate
  module instances of `@rapidrest/service-core` inside the SAME test process: one Vite-transformed
  (used by the test file and `Server`/`ConnectionManager`), one natively loaded (used by any code
  reached *through* `@rapidmx/restapi`, e.g. `findOrCreateWellKnownFolder`/`RecoverableRepoUtils`).
  Symptom: `ModelUtils`'s static `typeOrm` field (set once by `TypeOrmSupport.connect()`) is only
  visible on ONE of the two instances, so any restapi-side code hitting a SQL query building path
  throws "no SQL datasource has been initialized" - manifesting as a bare 500 on `SendMail`/
  `SmartForward`/`SmartReply`/`MeetingResponse`, since the framework's own `instanceof ApiError`
  error-mapping also silently swallows the real cause. Diagnosed by temporarily instrumenting the
  installed `node_modules/@rapidrest/service-core` `Server.js`/`TypeOrmSupport.js` with
  `console.error` (removed once confirmed - never commit node_modules edits). **Any future split
  package that itself calls into `@rapidmx/restapi` needs the same `ssr.noExternal` entry.**
- **Second, unrelated gap found while chasing the above**: this repo's own `test/server-mongo`/
  `test/server-sql` harness only mounted `EasRoute` - but several EAS tests simulate "the user
  renamed/deleted an item via the webmail REST API" by calling `PUT`/`DELETE /sql/folders/:id`
  and `/sql/messages/:id` directly, which needs `FolderRoute`/`MessageRoute` (from
  `@rapidmx/restapi/mongo`/`sql`) mounted too - not just re-exported as models. Added trivial
  one-line mount files for both, mirroring the monolith's own `test/server-{mongo,sql}/routes/
  {Folder,Message}Route.ts`. `test/server-{mongo,sql}/models/index.ts` was also narrowed from a
  wildcard `export *` (which pulled in every REST route/job class from `@rapidmx/restapi`,
  registering classes this harness has no business initializing) to a named export of just the
  8 model classes EAS actually needs.
- For the original design rationale behind the WBXML codec, the SyncKey watermark-cursor design, the
  per-command `EasCollectionSyncAdapter`s, and every other decision baked into this code, see the
  monolith's own `.claude/NOTES.md` (`d:\github\rapidrest\mail`) — that history wasn't duplicated
  here since it predates this repo's existence.

### 2026-09-07 — Spec-compliance audit: real `OPTIONS` discovery added; Sync gap clarified

- **JP asked whether this package is fully `MS-ASCMD`-compliant or a partial subset.** Answer: partial,
  deliberately. Real gaps beyond the ones already documented in `README.md`/source comments, confirmed
  by reading the actual handler code (not recalled from memory):
  - `SyncCommand.handle()` never reads the request's own `<Commands>` element at all - no
    `findChild(collection, "Commands")` anywhere in the file. A real client's device-originated
    `Add`/`Change`/`Delete` (e.g. creating a new Contact/Calendar event/Task directly in the phone's
    native app, or saving a Drafts-folder item) is silently dropped - not rejected, not erred, just
    never looked at. `SendMail`/`SmartForward`/`SmartReply` are unaffected (separate commands, already
    fully working) - only Contacts/Calendar/Tasks/Drafts creation-on-device is the real gap.
  - No `OPTIONS` capability discovery (now fixed, see below).
  - Auth (`@Auth(["jwt"])`, no OAuth Authorization Server of its own) - JP confirmed this is **already**
    solved at the deployment level: `@rapidrest/auth`/`@rapidrest/auth-server` mint the JWT, and
    `auth.mydomain.com`/`mail.mydomain.com` sharing one parent domain means the browser/OS hands that
    JWT to this package via a domain-level cookie automatically. Not a gap in practice for that
    deployment shape - the `README.md` wording ("tracked as a follow-up in `@rapidrest/auth`") stays
    accurate as written (it correctly says the piece lives outside this package), just worth recording
    that it's not an open problem for JP's own actual deployment.
- **Fixed the `OPTIONS` discovery gap for real**, across two repos:
  1. `@rapidrest/service-core` (`d:\github\rapidrest\service-core`, a sibling checkout - not one of the
     four split packages): added `IHttpRouter.hasExplicitOptionsRoute(path)` (implemented in both
     `HttpRouter`/uWS and `BunRouter`/Bun, tracking literal non-`/*` paths registered via `.options()`,
     normalized for a trailing-slash mismatch either side), and changed `Server.ts`'s global CORS
     middleware to skip its blanket preflight `204` when that returns `true` for the request path -
     letting an app's own `@Options()` handler run instead. Verified via the full existing suite
     (1153/1153 passing) plus new unit tests on both routers and a new end-to-end `Server.test.ts` case
     (a fixture `@Options("capabilities")` route now actually answers with its own JSON body, while an
     unregistered path still gets the old blanket `204`). **Left uncommitted in that repo** - it's JP's
     own separate project, not something to commit without being asked there specifically.
  2. This repo: `BaseEasRoute.ts` gained a real `@Options()` handler (deliberately unauthenticated,
     matching real Exchange's own posture - capability discovery isn't mailbox access) answering
     `MS-ASProtocolVersions: 14.0,14.1` (confirmed via `[MS-ASHTTP]`/`[MS-ASWBXML]` research - 14.0 is
     the floor for the MIME-based `ComposeMail` code page this package's `SendMail`/`SmartForward`/
     `SmartReply` actually use; 16.0/16.1's `Oof`/`RightsManagementInformation` aren't implemented, so
     not claimed) and `MS-ASProtocolCommands` built dynamically from `this.handlers.keys()` (never a
     separately-maintained list that could drift from what a concrete subclass actually registers).
     **This only takes effect once the app's `@rapidrest/service-core` dependency actually includes the
     fix above** - on today's currently-published `service-core`, the CORS middleware still always
     answers `OPTIONS` with a bare `204` before this handler is ever reached. Tested via a direct
     method call in `test/routes/BaseEasRoute.test.ts` (proving the handler's own header-building logic
     is correct) rather than a real HTTP round trip, since the currently-pinned published `service-core`
     wouldn't exercise the new code path at all yet.
