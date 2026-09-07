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

### 2026-09-06/07 — Practical full EAS compliance push

JP asked to finalize this package toward full `MS-ASCMD` compliance (scoped decision: every command a real
client uses, explicitly excluding `Notes`/`DocumentLibrary`/`RightsManagement`/`Find`/`AirNotification` -
legacy corners even mature reference servers barely implement). Landed as a sequence of independently-tested
commits, each keeping the 95%/100%/100%/100% coverage gate green:

- **Real bug found and fixed first**: `RepoUtils.update()` (service-core) never mutates its `existing`
  argument - it returns a freshly-fetched instance with the bumped `version` instead, filtering the DB write
  by the *patch's* `version`. Every `DeviceSyncState` writer (`ProvisionCommand.persist`,
  `FolderSyncCommand`/`SyncCommand.persistSyncKey`, `BaseEasRoute.dispatch()`'s trailing `lastSyncAt` write)
  discarded that return value and kept reusing the same in-memory object, so a *second* write within one
  request silently matched zero rows. Added `EasSyncKeyUtils.persistDeviceSyncState()` as the one correct way
  to write it going forward. This was masking itself as `lastSyncAt` never persisting; left unfixed it would
  have broken multi-collection `Sync` (below) silently.
- **`restapi` gained new `DeviceSyncState`/`Mailbox` fields** (`folderCollectionClasses`, `remoteWipeRequested`/
  `remoteWipeAccountOnly`/`remoteWipeAcknowledgedAt`, `oofEnabled`/`oofMessage`/`oofStartTime`/`oofEndTime`).
  **Gotcha**: `oofMessage` needed `@Nullable` despite being a required `string` - this framework's
  `ObjectUtils.validate()` treats an empty string as equivalent to null/undefined for any non-nullable field,
  and this field's natural default (no Oof configured yet) is `""`.
  **Portal links don't work across these sibling repos** - tried `portal:../restapi` +
  `portal:../../rapidrest/service-core` to test against local changes before JP published; even with
  `--preserve-symlinks` (both Node's CLI flag and Vite's own `resolve.preserveSymlinks`, needed for different
  reasons), each repo's own separately-`yarn install`ed `node_modules` produces a second physical copy of
  `@rapidrest/core`/`@rapidrest/service-core`, breaking `instanceof ApiError`/decorator-metadata identity
  across the boundary. Vite's own resolution made it worse, not better, when forced to preserve symlinks (one
  path resolved to a raw `.ts` source file with no build step). Reverted; JP published both packages for real
  instead (`service-core` 1.5.0, `restapi` 0.2.0) and this repo just bumped its own dependency ranges - the
  "right" fix for a true monorepo (shared root `node_modules`) doesn't apply here since these are separate
  standalone repos, each with their own lockfile.
- **`service-core`'s real `OPTIONS` discovery fix (`hasExplicitOptionsRoute`) was NOT actually left
  uncommitted** as the previous entry below claims - it was already committed locally (`c8cde0b`) just not
  pushed to `origin`. Pushed and released as 1.5.0; confirmed live end-to-end here (updated the two
  integration tests that previously documented the CORS-intercepts-everything behavior).
- **`Sync` now handles multiple `<Collection>`s per request** (previously answered only the first) - all
  per-collection `SyncKey`/remembered-`Class` writes for one request batch into a single
  `persistDeviceSyncState` call at the end, never one per collection (exactly the bug above). `Class` can now
  be omitted after a collection's first (`SyncKey "0"`) request too, remembered in the new
  `folderCollectionClasses` field.
- **`EasCollectionSyncAdapter` widened**: `fromApplicationData` may return a `Promise` now, and adapters are
  instantiated via `ObjectFactory` (`adapterClass`, not a pre-built `adapter` instance) so one can `@Inject`
  its own dependencies. This unblocked **`Email` Draft `Add`/`Change` via `Sync`** (previously `Email` only
  accepted client-originated `Delete`) - plain-text-only, no attachments. `Message.bodyBlobKey` is documented
  as holding raw MIME "unmodified from ingestion/send", and `ItemOperationsCommand.fetchMessage` parses it
  with `simpleParser` unconditionally, so a Draft's body is wrapped in a minimal hand-built RFC 5322 message
  rather than stored as bare text - keeps that contract intact for every consumer, not just this write path.
- **`MeetingResponse` decline now soft-deletes the `CalendarEvent`** (matching real Exchange) instead of just
  flipping the caller's own `Attendee.responseStatus` - each attendee already has their own row
  (`mailboxUid`-scoped), so this only removes the meeting from the declining attendee's own calendar.
- **New WBXML tag tables**: `Move`/`ItemEstimate`/`ResolveRecipients` pages, previously registered as enum
  values only. `GetItemEstimate`'s modern (14.0+) shape reuses `AirSync`'s own `Collections`/`Collection`/
  `Class`/`CollectionId`/`SyncKey` via `SWITCH_PAGE`, not `ItemEstimate`'s own legacy `Folders`/`Folder`
  tags - same cross-page-reuse pattern `ItemOperationsCommand.fetchMessage` already used.
- **Three new commands**: `GetItemEstimateCommand` (read-only, never touches a `SyncKey`), `MoveItemsCommand`
  (`Message` only, verifies claimed source folder + destination folder ownership), `ResolveRecipientsCommand`
  (GAL substring match, duplicating `SearchCommand`'s own matching logic rather than extracting a shared
  `GalMatcher` DI abstraction for just two call sites - not worth the new plumbing). Both `Move`/
  `ResolveRecipients` use an honest binary Status mapping (success vs. one generic failure code), matching
  `ProvisionCommand`'s own established precedent, rather than a byte-exact code enumeration nobody could
  verify without the published spec in hand.
- **`Settings` gained `Oof` `Get`/`Set`** - single combined reply message (not the spec's three
  audience-specific variants), `StartTime`/`EndTime` use MS-ASDTYPE's plain `dateTime` type (not Calendar's
  Compact DateTime - a real, distinct MS-ASSETTINGS detail, not assumed).
- **`MS-ASProtocolVersions` now also declares `16.0`/`16.1`** (previously withheld specifically because `Oof`
  was missing) - `RightsManagementInformation` remains unimplemented but doesn't gate the version string,
  since `MS-ASProtocolCommands` (derived live from registered handlers) is the real capability gate.
- **`ItemOperations` now handles multiple `<Fetch>`es per request** (previously first-only), `Options`/
  `BodyPreference` (`Type 4` returns raw MIME verbatim, others truncate to `TruncationSize` on a UTF-8-safe
  boundary), rejects `Store: DocumentLibrary` with 400, and implements `EmptyFolderContents` (soft-deletes a
  folder's messages, rejecting `DeleteSubFolders`). **Corrected a wrong assumption before writing any code**:
  the original plan treated `Store` as a write/upload op and `ItemOperations`' own `Move` as a simple
  per-message move - a research pass against Microsoft's published `MS-ASCMD` XSD confirmed `Store` is actually
  just a required `Fetch` child selecting `"Mailbox"`/`"DocumentLibrary"` (a selector, not a write), and `Move`
  here relocates an entire *conversation* via `ConversationId` (unrelated to the standalone `MoveItemsCommand`
  above) - `ItemOperations` has no write capability at all, and conversation-`Move` stays an explicit,
  documented gap.
- **`Provision` now enforces real policy**: password/encryption requirements are `@Config`-driven
  (`mail:eas:provision:*`, permissive-but-not-empty defaults), and phase-2 acknowledgement now actually reads
  the client's own per-`Policy` `Status` - anything but `"1"` (missing included) is rejected without
  provisioning, not just a `PolicyKey` mismatch as before.
- **Full three-step `RemoteWipe` flow implemented**, riding the existing `DeviceSyncState.remoteWipeRequested`/
  `remoteWipeAccountOnly`/`remoteWipeAcknowledgedAt` fields and the pre-existing 449 provisioning gate (no new
  transport plumbing needed - a wiped device is simply forced back through `Provision` next request): admin
  sets the flag → `ProvisionCommand.issuePolicy` sees it and sends a `RemoteWipe` directive instead of a policy
  document → device wipes and acks with a bare `<RemoteWipe><Status>1</Status></RemoteWipe>` → flag clears but
  `provisioned` deliberately stays `false`, requiring a genuine fresh handshake to re-add the account.
  `remoteWipeAccountOnly` is recorded for admin audit only - the wire directive doesn't distinguish full-device
  vs. account-only wipe, since that split needs an MDM-capable client extension out of this library's scope.
- **New admin route**: `BaseDeviceSyncStateRoute` (`POST /:uid/remote-wipe`, `@Auth(["jwt"])` +
  `trustedRoles`/`UserUtils.hasRoles` gating, same pattern as `restapi`'s `BaseMailboxRoute`) - lives in this
  package rather than `restapi` since `DeviceSyncState` is protocol-internal, not a domain object `restapi`
  otherwise exposes a route for.
- **This closes out the practical-full-compliance roadmap** - every item from the original scoping conversation
  has now landed (multi-collection `Sync`, Email drafts, `ItemOperations` write-adjacent behaviors, the three
  new commands, `MeetingResponse` decline, `Settings`/`Oof`, and `Provision`/`RemoteWipe`).

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

### 2026-09-06 — Closed the client-originated Sync `Commands` gap (audit item #4)

- **JP confirmed this specific gap (not `SendMail`, already working) should be fixed now.** `SyncCommand`
  now reads the request's own `<Commands>` element and applies `Add`/`Change`/`Delete` for
  `Contacts`/`Calendar`/`Tasks` - a device creating/editing/deleting an item directly (the normal way a
  phone's native Contacts/Calendar/Tasks apps behave against an EAS account) now actually persists.
  `Email` accepts `Delete` only - `Add`/`Change` still answered with Status `6`, since `[MS-ASCMD]` itself
  disallows non-draft email `Add` and this pragmatic subset doesn't implement Drafts-via-`Add` or
  Read/Flagged-via-`Change` (composing/sending goes through `SendMailCommand` instead) - a documented gap,
  not silently dropped, same as before.
- Verified the exact `Responses`-element inclusion rule from `[MS-ASCMD]`'s own "Add (Sync)"/"Sync" spec
  pages rather than assuming it: `Add` always gets a `Responses/Add` entry (must report the assigned
  `ServerId`); `Change`/`Delete` only get one on **failure** - a silent response means "assume it worked."
  Status codes used: `1` success, `6` client/server conversion error (malformed item, or no adapter support
  at all for that collection/operation), `7` conflict (optimistic-concurrency version mismatch), `8` object
  not found.
- `EasCollectionSyncAdapter` gained two **optional** interface members - optional is the deliberate
  capability-gate mechanism, not a separate flag that could drift out of sync with what an adapter actually
  implements:
  - `fromApplicationData(el, existing?)`: the reverse of each adapter's existing `toApplicationData`,
    implemented for `Contacts`/`Calendar`/`Tasks` (not `Email`). Ghosts per MS-ASCMD's own rule - a field's
    tag missing from the request means "leave it unchanged," not "clear it" - so the same method serves
    both `Add` (partial merged onto a fresh entity) and `Change` (partial merged onto `existing`).
  - `newEntityDefaults()`: supplies defaults a brand-new entity needs regardless of what the client sent.
    Only `CalendarSyncAdapter` implements it (`icalUid`/`sequence`) - EAS's own `Add` has no wire
    representation for either, and the model's own constructor default of `icalUid: ""` for every
    Sync-created event would violate RFC 5545's uniqueness expectation for `UID`. Mirrors MAPI's identical
    `RopSaveChangesMessageHandler` pattern (`${crypto.randomUUID()}@mapi`), `@eas` suffix instead.
- `SyncCommand`'s own `@Init` now builds `RecoverableRepoUtils` (from `@rapidmx/restapi`) instead of plain
  `RepoUtils` - the exact same fix `BaseMapiEmsmdbRoute.ts` already needed for MAPI, necessary here because
  `SyncCommand` now originates its own soft-deletes via `applyDelete` (plain `RepoUtils.delete()` doesn't
  bump `dateModified`/`version`, which would silently break this same class's own watermark-based deletion
  detection for anything deleted via `Sync` instead of the REST API).
- Watermark advancement: computed the outgoing `changes` (server-side Adds/Changes/Deletes to report)
  against the *old* watermark, *before* applying this round's own incoming `Commands` - otherwise a
  client's own fresh write would echo straight back as a `Commands` entry in the very same response. After
  applying, the persisted watermark only ever extends forward past what `computeChanges()` itself already
  found (`Math.max` against the actual `dateModified` of successful writes) - never jumps straight to "now"
  unconditionally, which would silently skip not-yet-enumerated pending changes whenever
  `changes.moreAvailable` is `true`.
- **Testing split**: real version-conflict (Status `7`) and several malformed-item/no-adapter branches
  can't be reached through a real single-request HTTP+DB round trip by construction (`SyncCommand` always
  echoes back the `version` it just read in the same request, so `applyChange`'s own optimistic-concurrency
  check can only fail from a genuine concurrent write racing between its `findOne()` and `update()` calls -
  not reproducible deterministically over real HTTP). Added a new isolated `test/commands/SyncCommand.test.ts`
  (fake repo/adapter doubles, same "poke a private field, mirror `MeetingResponseCommand.test.ts`'s own
  precedent for an unreproducible race" pattern already used elsewhere in this repo) for those branches,
  alongside real HTTP+DB round-trip tests in both `test/routes/{mongo,sql}/EasRoute.test.ts` for the
  reachable happy/not-found paths (Contacts/Calendar/Tasks Add creating a real persisted record, Calendar
  Add's `icalUid`/`sequence` defaults, Contacts Change/Delete against a real record, Email Add rejected,
  Email Delete accepted) and new `fromApplicationData` unit tests per adapter
  (`test/adapters/{Contacts,Calendar,Tasks}SyncAdapter.test.ts`, new files - ghosting/error-path edge cases
  are far more precise to verify directly than by threading malformed WBXML through a full round trip).
