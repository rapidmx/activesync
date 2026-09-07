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
  REST-layer helpers, `BlobStore`, and the scan pipeline. Linked locally via Yarn Berry's
  `portal:../restapi` (both repos are expected to live as siblings under `d:\github\rapidmx\`) until
  this package is actually published, at which point the `peerDependencies` semver range takes over.
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
