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
- **Commit discipline.** Don't `git commit` unless explicitly asked for *that specific piece of
  work*. An autonomous-execution/"commit as you go" approval given for one approved plan (e.g. via
  plan mode) is scoped to that plan only — it does not carry forward to later, separate requests in
  the same session, even ones that look similar in kind (a follow-up review-and-fix pass, a
  refactor, a new feature), and even after a full review-and-fix cycle with passing tests. Default
  to leaving changes staged/unstaged and saying so; only commit automatically within the exact
  scope of a plan that was explicitly approved as autonomous. If unsure whether new work falls
  inside that scope, treat it as outside and ask.
- **Commit message style: a flat list of one-line, verb-led items — no summary/title line, no
  `-`/`*` bullet markers.** This isn't just a style preference — it's dictated by how `release`
  (`@rapidrest/cli`) actually builds `CHANGELOG.md`. `collectChangelogBullets`/
  `classifyChangelogLine` (that repo's `src/lib/release.ts`) parse `git log --pretty=format:%B` and
  treat **every non-blank line of a commit's full message as its own changelog bullet** — there is
  no subject/body distinction. A conventional "short imperative subject + blank line + prose body"
  commit therefore leaks one changelog bullet per body sentence, and a `-`/`*`-prefixed line breaks
  `classifyChangelogLine`'s verb detection (it reads the line's first whitespace-delimited word as
  the verb; a leading `-` defeats that lookup and the dash leaks into the changelog text as
  `"- - Added foo"`). Correct format:
  - No separate summary/title line — if a commit needs an overview, that overview is itself just
    one more flat line, not a heading distinct from the rest.
  - No bullet-marker prefix of any kind — write bare lines.
  - Lead each line with an imperative verb where it fits: `Add`/`Fix`/`Remove` (and `-ing` forms)
    are recognized and become `Added`/`Fixed`/`Removed` entries; `Configuring`/`Converting`/
    `Refactoring`/`Updating`/etc. become `Changed`. Anything else still works, defaulting to
    `Changed` verbatim — see `CHANGELOG_VERB_REWRITES` in that repo's `src/lib/release.ts` for the
    full map.
  - A blank line before a trailing git trailer (`Co-Authored-By:`, `Signed-off-by:`, etc.) is fine
    — trailers matching `CHANGELOG_NOISE_PATTERNS` are dropped from the changelog — but nothing
    else should follow the item list.
  This mirrors JP's standing convention across his other repos; copy this exact rule verbatim into
  each sibling repo's own NOTES.md rather than paraphrasing it, since the paraphrase is what caused
  this to be gotten wrong in the first place (see `@rapidrest/cli`'s own NOTES.md, 2026-09-07 entry,
  for the full incident writeup and the `CHANGELOG_NOISE_PATTERNS` fix that accompanied it).

### 2026-09-14 (2) — Round-2 review fixes (remote-wipe purge, ResolveRecipients DoS/status, labelUids, Draft-only body)

Each finding was confirmed in code first. Not committed; no version or peerDependency changes.

- **Cleanup job purged pending remote wipes.** `EasDeviceStateCleanupJob` deleted stale and never-synced rows
  even with `remoteWipeRequested: true`, so a lost device that reconnected later re-paired without being
  wiped. Both queries now also filter on `remoteWipeRequested` via a protected
  `noPendingWipeQueryValue()`. Mongo uses `ne(true)`, which matches `false`, `null` and a missing field.
  `EasDeviceStateCleanupJobSQL` overrides it with
  `Raw("(col IS NULL OR col = :noPendingWipe)", false)`, because SQL `!=`/`NOT IN` never match `NULL`
  (`ne(true)` there would have made unset rows unpurgeable). Both backends' job tests cover this.
- **ResolveRecipients DoS.** The number of `<To>` elements was unbounded, and each one cost 3 regex queries.
  More than `MAX_RESOLVE_RECIPIENTS_TO` (100, per [MS-ASCMD]'s "MUST NOT contain more than 100 To elements")
  now gets top-level Status `5` (protocol error) with no queries. That code comes from the spec as recalled;
  the repo holds no copy of it to check against. An empty or whitespace-only `To` would have compiled to
  `regex()`, matching every contact. It now gets that recipient's Status `4` without a query.
- **ResolveRecipients error mapping.** Every exception used to become a per-recipient Status `4`, including DB
  outages. Now only an `ApiError` with status 400 (e.g. a pattern service-core rejects) does. Anything else
  fails the whole command with top-level Status `6` (server error) and is logged at error level.
- **`labelUids` spliced into `in(...)`.** `resolveLabelNames()` now skips any entry that isn't a lowercase
  UUID. `me` would have become the caller's uid (or a 403), and a comma would have split one value into several.
- **Manifest.** Added `"mailboxScopedData": true` to `rapidmx.plugin`, since `DeviceSyncState` is
  `@MailboxScopedData`. `test/plugin.test.ts` asserts it; the installed `parsePluginManifest` ignores the
  unknown field.
- **Sync `Change` could overwrite a received message's original MIME (outside-diff check: real).** Evidence:
  - `SyncCommand.applyChange` accepts `Email` Changes for any folder the caller can UPDATE, not just Drafts.
  - `EmailSyncAdapter.fromApplicationData` reused `existing.bodyBlobKey` and `put()` over it.
  - Body blobs are shared: restapi's `ScanQueueJob` gives an inbox-rule copy the same `entry.rawBlobKey` as
    the delivered message, so one overwrite rewrote both.
  - Retention and erasure jobs and `DataExportJob`/mbox read that blob as the original RFC 5322 source.
  - [MS-ASCMD]/[MS-ASEMAIL] only allow `Add`/`Change` of the body for Drafts.

  Fix: `EmailSyncAdapter` gained an abstract `folderClass` (`FolderMongo`/`FolderSQL` in the concrete
  adapters). A `Change` carrying `Body` for a message whose folder isn't `FolderType.DRAFTS` (or no longer
  exists) throws `ApiError` 400, which `applyChange` reports as Status `6`. Nothing is written. Body writes
  (Draft Add or Change) now always mint a fresh `bodies/<uuid>` key, never overwriting. Non-body Changes
  (Read/Flag) on non-drafts are unaffected and do no folder lookup.
  - Follow-up (not done): a Draft's superseded blob is now orphaned, and so is one whose `update()` then fails
    its version check. Deleting the old blob inline was avoided because it could be shared.
  - Still open: Subject/To/Cc/Bcc/Importance Changes on non-drafts still update DB fields. The blob stays
    intact, but the spec disallows these too.
- Tests:
  - `test/commands/ResolveRecipientsCommand.test.ts`: Status 5 at 101 `To` elements, 100 still OK, empty `To`
    gets 4 with no query, non-400 errors give Status 6.
  - `test/adapters/EmailSyncAdapter.test.ts`: non-UUID labelUids, fresh blob key, non-draft body refused,
    non-body Change still applied.
  - `test/routes/{mongo,sql}/EasRoute.test.ts`: Draft Change writes a new key, and an Inbox body Change gets
    Status 6 with the original MIME byte-identical.
  - Both cleanup-job tests; `test/plugin.test.ts`.

### 2026-09-14 — Review-finding fix pass (perf batching, WBXML NUL injection, regex length, GAL guard)

Each finding was confirmed in code before fixing (the reviewer's line numbers were stale, the code shapes matched).
Not committed; no version/peerDependency changes.

- **Label/Search N+1 batched.** Added optional `EasCollectionSyncAdapter.toApplicationDataBatch(items)`;
  `EmailSyncAdapter` implements it by grouping distinct `labelUids` per `mailboxUid` and fetching each group
  with one `uid: in(...)` find (chunked at 500, `limit` in both query and options, since `RepoUtils.find()`
  defaults to 100 rows). `toApplicationData()` delegates to it. `SyncCommand` renders adds+changes in one
  batch call (falling back to per-item for adapters without it). `SearchCommand`'s Mailbox branch now loads
  all hits with one `uid: in(...)` find instead of a sequential `findOne` per hit, and memoizes
  `hasPermission` per `folderUid`; relevance order, duplicate hits and stale-entry skipping are unchanged.
  Categories now come out in `labelUids` order (was DB order). Supersedes the "one `find()` per labelled
  message" tradeoff noted in the 2026-09-13 (2) entry.
- **WBXML `STR_I` NUL injection.** `WbxmlEncoder.writeStrI` strips U+0000 (UTF-8 emits 0x00 for no other code
  point), so a user-controlled label name/subject can no longer terminate the inline string early and inject
  tokens. The NUL is built via `String.fromCharCode(0)`: tool edits typing an escaped NUL wrote a literal 0x00
  byte into the source twice this session. Check with `file` that a source file still reads as text.
- **Regex length guard.** `service-core`'s `regex()` rejects operands over its private
  `ModelUtils.MAX_PATTERN_LENGTH` (100), checked after escaping, so a metacharacter-heavy term under 100 raw
  chars could 400 the whole command. New `src/RegexPatternUtils.ts` `boundedEscapedPattern()` truncates the raw
  term per code point so the escaped form fits. Used by GAL Search and ResolveRecipients. ResolveRecipients
  also now catches a per-recipient lookup failure and reports that recipient as Status `4`, not failing all.
- **GAL without a SearchProvider.** `SearchCommand.handle()` no longer requires `searchProvider`; only the
  Mailbox branch checks it (500 if missing).
- README package names updated to `@rapidmx/activesync-plugin` / `@rapidmx/autodiscover-plugin`.
- Tests: new `test/commands/ResolveRecipientsCommand.test.ts`, `test/RegexPatternUtils.test.ts`; extended
  `SearchCommand.test.ts`, `EmailSyncAdapter.test.ts`, `WbxmlCodec.test.ts`, and both `EasRoute.test.ts`.

### 2026-09-13 (3) — Switched GAL search from `like()` glob-wrapping to `regex()`, matching the `mapi` plugin's own fix

JP pointed out the sibling `mapi` plugin hit the exact same `service-core` 2.0 `like()`-glob regression this repo
fixed two entries below, and its own follow-up commit (`424bd27`) went further: switched from escaping-then-
wrapping a glob pattern for `like()` to using the newer `regex()` operator directly. Checked out `mapi`'s actual
diff (not just its commit message) before assuming the same applies here - it does, cleanly:

- **`regex()` (`@rapidrest/service-core` ^2.0) takes a real, unanchored regular expression**, case-insensitively
  compiled on both backends (Mongo `$regex`/`$options:"i"`; SQL `~*`/`REGEXP`/`better-sqlite3`'s custom `REGEXP`
  function) - substring matching is its *default* behavior, unlike `like()`'s anchored glob translation, which
  needed wrapping the term in `*...*` to get the same effect. `StringUtils.escapeRegExp(query)` (already in
  `@rapidrest/core`, no new dependency) escapes every regex metacharacter *including* `*`/`?` - closing the one
  residual gap the glob-wrap approach couldn't: a search term containing a literal `*` or `?` no longer acts as
  a wildcard, since `regex()` has a real escape mechanism where glob syntax has none.
- Replaced `SearchCommand.ts`'s `globPattern()`/`ResolveRecipientsCommand.ts`'s duplicate of it with a direct
  `StringUtils.escapeRegExp(...)` call at each of the two call sites - no wrapping function needed at all now,
  since `regex()` doesn't require the `*...*` dressing `like()` did.
- **`regex()` is independently validated by the framework** (`ModelUtils.isUnsafeRegexPattern`) against
  catastrophic-backtracking shapes *and* a 100-character pattern length cap - neither applies to `like()`. Since
  the entire query is escaped before it ever reaches the operator, no unescaped metacharacter can form one of
  the rejected shapes; the length cap is a real, if practically unlikely, new constraint (a GAL/ResolveRecipients
  search term over 100 characters now gets a framework-level 400 it wouldn't have before) - worth knowing if a
  future report ever traces back to it, not worth engineering around today for names/partial-address queries.
- Added a regression test per command, per backend (`"a.b"` matching `"a.b Corp"` but not `"aXb Corp"`) - the
  exact shape that would have failed under either the pre-2.0 assumption (double-escaping) or an unescaped
  `regex()` call (over-matching), mirroring `mapi`'s own added coverage for the identical fix.

### 2026-09-13 (2) — Closed the deferred `Message.labelUids` → Categories gap

JP asked to address the remaining gap the prior entry deliberately deferred. Implemented it after all, since the
real blocker (widening `EmailSyncAdapter.toApplicationData()` to async) turned out cheaper than first estimated:

- **Widened `EasCollectionSyncAdapter.toApplicationData()` to `WbxmlElement | Promise<WbxmlElement>`** - the
  exact same optional-async shape `fromApplicationData()` already had (for `EmailSyncAdapter`'s own `BlobStore`
  write), just applied to the other direction. `SyncCommand.itemToCommandElement()` and
  `SearchCommand.messageToResult()` (both call sites) now `await` it; the three adapters that stay synchronous
  (`Contacts`/`Calendar`/`Tasks`) are unaffected - `await` on a non-`Promise` value resolves immediately.
- **`EmailSyncAdapter` is now `abstract`** with a `protected abstract labelClass: any`, resolved via its own
  `@Init` into a `Label` repo (mirroring every command's own `RepoUtils` construction pattern - adapters go
  through the identical `ObjectFactory.newInstance()` DI lifecycle as commands, confirmed by reading how
  `SyncCommand.init()` already constructs each adapter this way). Added `EmailSyncAdapterMongo`/`SQL` concrete
  subclasses (`src/adapters/{mongo,sql}/`, a first for this adapter - every other adapter stays a single
  shared class since none of them needed a backend-specific model class before) and rewired
  `SyncCommandMongo`/`SQL`'s `Email` binding and `SearchCommandMongo`/`SQL`'s own adapter construction to the
  new concrete classes instead of the old bare `EmailSyncAdapter`.
- **Read-only**, unlike `Contact.categories`: a `Label` is a real mailbox-scoped entity referenced by uid, not a
  free-form string array, so a write path would need to resolve category name strings back to `Label`s *and*
  create new ones on the fly for names that don't exist yet - real added scope deliberately left as a
  documented gap, matching this adapter's own existing precedent for `Email2:ConversationId`.
- **One `find()` per message that actually has labels** (`labelUids` empty/absent short-circuits before ever
  touching the repo), not batched across a whole `Sync` page or search result set - a documented, modest N+1
  tradeoff accepted rather than widening the adapter interface further to let a caller pre-resolve names for an
  entire batch. A stale `labelUids` entry (the `Label` was since deleted) is silently dropped via the same
  `in(...)` query-DSL operator confirmed working in the `SyncCommand`/`ResolveRecipientsCommand` fixes above.
- **Test harness gap found while writing the first integration test**: `test/server-{mongo,sql}/models/index.ts`
  (the named re-export list gating which `@DataStore` classes the test `ClassLoader` actually discovers) didn't
  include `Label{Mongo,SQL}` at all - `EntityMetadataNotFoundError` on the very first `createLabel()` call.
  Added it alongside the other eight model classes already listed in both files.

### 2026-09-13 — Caught up to `restapi` 0.8.x (65 commits: E2E encryption, search overhaul, compliance roadmap); added Mailbox-store Search

JP asked for a full review of `restapi`'s activity since this repo's `0.3.1` pin, including its new
`specs/end-to-end_encryption.md`/`specs/search.md` design docs, and to implement whatever ActiveSync-protocol-
relevant surface it now supports. Bumped `@rapidmx/restapi` to `0.8.x` and `@rapidrest/service-core` to `2.x`
(restapi's own peer range moved to `service-core` 2.x's query-DSL overhaul).

**Scoping pass**: the overwhelming majority of the 65 commits (S/MIME digital signatures, end-to-end encryption
key vault/escrow/discovery, GDPR export/erasure, Legal Hold/Matter/eDiscovery, mailbox import, data retention,
Label entity + mail filter action, `FolderType.ARCHIVE` + archive REST action, SES transport, S3 blob store) are
either pure server/admin/compliance features with no EAS wire mechanism at all, or - for E2E specifically -
fundamentally client-side crypto (key generation/wrapping/S-MIME construction happens on the device; this
library's `SendMail`/`SmartForward`/`SmartReply` already relay a client-supplied raw MIME blob unmodified, so a
client that builds its own S/MIME structure already round-trips through this library with no changes needed).
Two genuinely new things landed:

- **Fixed real breakage from the version bump** (not new features, but required for the bump to be usable at
  all):
  - `FolderType.ARCHIVE` (new restapi enum member) broke `FolderSyncCommand`'s exhaustive `Record<FolderType,
    string>` map - `tsc` catches this (confirmed via `npx tsc --noEmit`, which `yarn lint`/`yarn test` do NOT
    run - worth remembering: neither of this repo's two actual gates type-checks `Record<Enum,X>`
    exhaustiveness, only a real `tsc` invocation does). Mapped to the same Type `12` (generic user folder)
    fallback as `USER`/`JUNK` - MS-ASCMD's `FolderHierarchy` `Type` enumeration has no dedicated Archive code.
  - **`@rapidrest/service-core` 2.x's `like()` operator now compiles glob syntax (`*`/`?`) instead of the old
    per-backend split this file's own doc comments described (Mongo: raw unanchored regex; SQL: exact-unless-
    `%`-wrapped)** - confirmed by reading `ModelUtils.ts`'s `globToLike()`/`globToRegExpSource()` directly, not
    assumed from the changelog. This was a real, silent functional regression risk: `SearchCommand`/
    `ResolveRecipientsCommand`'s existing `escapeForLikeQuery()` backslash-escaped regex metacharacters
    (`. ( ) + ? ^ $ { } | [ ]`) on the assumption Mongo's `like()` compiled to raw regex - but neither
    `globToLike` nor `globToRegExpSource` recognize a backslash as an escape at all, so a query containing any
    of those characters (e.g. searching "jane.doe" or "a+b") would have started matching a literal backslash
    that was never in the stored data, breaking the match entirely. Fixed by replacing the escape function with
    a plain `*query*` glob-wrap (`globPattern()`) - the framework's own doc comment for `globToLike` explicitly
    says a literal `*`/`%`/`_`/`?` can't be fully escaped either way ("a narrow, documented limitation"), so
    over-matching on those four characters is accepted, not worked around. Also deleted the now-provably-false
    per-backend `likePattern()` abstract hook and all four Mongo/SQL overrides, since both backends behave
    identically under the new glob translation - a real simplification, not just a bug fix.
  - `restapi`'s `BaseMessageRoute`/`ScanQueueJob` now unconditionally `@Inject("DnsResolver")` (federated-peer
    detection for the new receipt/encryption-key scoping) - `Server.start()`'s eager route instantiation failed
    outright in every integration test with "No class found with name: DnsResolver" until a `StaticDnsResolver`
    test double (always throws NXDOMAIN-shaped errors, matching "no `_rapidmx` record") was registered in
    `testDoubles.ts` alongside the existing `BlobStore`/`SearchProvider`/etc. doubles.
  - `SearchProvider` interface gained `candidates()` (Tier 3 candidate-set query) - added a trivial
    implementation to `NoopSearchProvider` so it still satisfies the interface.
  - `Message` gained a new required `encrypted: boolean` field - added to `EmailSyncAdapter.test.ts`'s
    `baseMessage` fixture (along with four already-required receipt fields the fixture had apparently never
    actually carried - `tsc -p tsconfig.test.json` was never run as a gate here either, so this had been
    latently wrong since the receipt feature landed and nothing caught it).
- **Added EAS `Search` for the `Mailbox` store** (previously `GAL`-only) - real mailbox full-text search,
  backed by `restapi`'s now much richer `SearchProvider` (the search overhaul in `specs/search.md`: operator
  grammar, `folderUid`/`flags`/`hasAttachments` schema, Tier 3 candidates). **Pragmatic subset**: only `Class`
  `Email` (matches the `GAL`-only precedent this file already set for search generally - Contacts/Calendar/
  Tasks search via `Mailbox` store is a documented gap); only the common real-world `Query` shape -
  `Class`/`CollectionId`/`FreeText`, optionally grouped under one `And` (both forms accepted, since the schema
  permits omitting the wrapper) - not the full recursive `And`/`Or`/`GreaterThan`/`LessThan` boolean-tree
  grammar. Each hit is re-verified for `READ` on its own current `folderUid` before being included -
  `SearchProvider`'s index is scoped by `mailboxUid` alone, not per-folder ACL, so (unlike `GAL`, whose
  `Contact.find()` query is already mailbox-scoped end to end) this is the one place in this command that still
  needs a per-result ACL check, the same "orphaned folderUid" pattern already established for `ItemOperations`
  Move. A stale index entry whose `Message` has since been hard/soft-deleted is silently skipped, not treated
  as an error. `SearchResultPage` carries no total count (full-text relevance search doesn't compute one
  cheaply), so `Total` here honestly means "how many matches this request's own capped fetch actually
  returned," not an exact server-side count - documented as an approximation, same spirit as `GAL`'s own
  already-approximate status-code enumeration. Result properties reuse `EmailSyncAdapter.toApplicationData()`'s
  own field mapping directly (its `.children`) rather than a second parallel mapping, so `Search` and `Sync`
  can never render the same message differently.
- **Considered and rejected**: wiring the new `EncryptionPolicy` singleton (tri-state
  `automatic`/`optional`/`prohibited`, independently per same-org/federated/external recipient tier) into
  `ProvisionCommand`'s existing `RequireSignedSMIMEMessages`/`RequireEncryptedSMIMEMessages` policy booleans.
  The semantics don't actually line up: MS-ASPROV's fields mean "the device MUST sign/encrypt every outgoing
  message," a blanket per-device mandate, while `EncryptionPolicy` is a nuanced per-recipient-tier default that
  can legitimately be `automatic` for one tier and `prohibited` for another - collapsing that into one boolean
  would misrepresent server policy to the device rather than honestly reflect it. No corresponding change made.

### 2026-09-08 (2) — Adversarial two-agent review #2, 6 confirmed findings fixed

JP asked for another full adversarial two-agent review (correctness/bugs-lens + security/performance-lens, same
pattern as the 2026-09-07 entry below) covering all of `src/`, including the conversation-`Move`/`ConversationId`/
`Categories` work from the same day's earlier session. Verified every claim against actual source (one agent
claim about `SyncCommand`'s watermark needed a framework-source read to confirm precisely) before fixing:

- **HIGH, fixed**: `ItemOperationsCommand.moveConversation` fell through to `Status "1"` (success) even when
  every message sharing the `ConversationId` was skipped for lacking `UPDATE` - a device could be told a move
  succeeded when nothing moved. Now tracks whether any message actually moved and returns `Status "3"` if not.
- **HIGH, fixed**: `PingCommand` never checked ACL on client-supplied folder uids before subscribing to their
  Redis pub/sub channels - the one command in the codebase that had this gap (every other command checks
  ownership on a client-supplied id). Concretely: a device that once had a folder shared with it could keep a
  live activity signal for that folder indefinitely, even after the share was revoked, since `Ping` never
  re-checks. Now filters the requested folder list down to only those the caller currently has `READ` on
  before subscribing (not a hard failure - `Ping`'s wire response has no per-folder status to report a partial
  denial through, and a client has no way to know its access changed before it re-sends the same list).
  `PingCommand.test.ts`'s own bespoke minimal config double (deliberately DB-less, since `Ping` itself needs no
  database) can't construct a real `ACLUtils` via `ObjectFactory` - added a `createCommand()` test helper that
  stubs `aclUtils` directly after construction instead.
- **MEDIUM, fixed**: `EmailSyncAdapter.fromApplicationData` ghosted `To`/`Cc` as one combined group rebuilt from
  scratch rather than per-type against `existing.recipients` - a `Change` touching only `To` silently dropped
  any existing `Cc`. `Bcc` (MS-ASEMAIL2's own tag, already in the codec's tag table) was never handled in either
  direction at all. Both fixed together: each of `To`/`Cc`/`Bcc` is now ghosted independently, and `Bcc` is
  read/written symmetrically with the other two (including in the built Draft MIME's own `Bcc:` header).
- **MEDIUM, fixed**: `SyncCommand.applyDelete`'s watermark used a fresh `new Date()` captured after
  `repo.delete()` resolves - a deliberate prior-session fix for duplicate-Delete redelivery, but with its own
  narrow trade-off: since `computeChanges()` snapshots the folder *before* this round's own Delete runs, a
  genuinely concurrent unrelated write to a different message in the same folder landing in that narrow window
  could end up permanently skipped once the watermark advances past it. Fixed by re-reading the now-soft-deleted
  row's own real `dateModified` via `repo.findOne(uid, {ignoreACL:true, includeDeleted:true})` instead of
  approximating with wall-clock time - `RepoFindOptions.includeDeleted` already exists on the base `RepoUtils`
  (confirmed by reading `service-core`'s own source), no need for a `RecoverableRepoUtils`-specific cast.
- **LOW/performance, fixed**: `ItemOperationsCommand`'s `Fetch` loop had no cap on Fetches per request (each
  fully buffered in memory) - added `mail:eas:itemoperations_max_fetch` (default 25), rejected outright like
  `DeleteSubFolders`/`DocumentLibrary` rather than silently truncated.
- **LOW/performance, fixed**: `emptyFolderContents`/`moveConversation` ran unbounded `find()` queries. Added
  `mail:eas:itemoperations_batch_size` (default 500) and switched `emptyFolderContents` to a batched loop
  (repeated bounded `find()`+delete rounds until the folder is actually empty - a soft-deleted row stops
  matching the same query, so this always terminates) and capped `moveConversation`'s own query with the same
  limit.
- **Real bug found and reverted while fixing the above**: my first pass parallelized both batches' writes via
  `Promise.all` (independent rows, seemingly safe) - broke the SQL backend outright with `SqliteError: cannot
  start a transaction within a transaction`. `better-sqlite3` shares one connection per request and each
  `delete()`/`update()` opens its own transaction, so concurrent writes against it always fail; confirmed via
  a real failing SQL test run, not assumed. Reverted to sequential writes in both spots - only the read-only
  ACL permission checks (independent, no shared-connection transaction) are still parallelized via `Promise.all`
  in `moveConversation`. Worth remembering for any future "these look independent, parallelize them" instinct
  in this codebase: reads are fine, writes sharing the SQL connection are not.
- Two agent claims were investigated and found to already be correct as-is, not re-reported: `ItemOperations`
  Move's destination-folder ownership check itself (sound), and the WBXML codec's opaque/length encoding
  (round-trips correctly, verified against the codec's own passing round-trip tests).

### 2026-09-08 — Caught up to `restapi` 0.3.x: Categories, ConversationId, conversation `Move`

JP asked for a full review of `restapi`'s activity since this repo last pinned `0.2.x` (25 commits: iTIP meeting
invites, resource-mailbox auto-accept, `DistributionList`, `TransportRule`, `MailFilterRule`, MDN read/delivery
receipts, `Domain`/DNS setup, `Branding`, Focused Inbox, `Message.conversationId`/`conversations()`, recall,
`AuditLogEntry`, `TaskList`, anonymous booking, plus-addressing) and to implement whatever of that is actually
**ActiveSync-protocol-relevant** - the task was explicitly scoped to what MS-ASCMD itself has a wire mechanism
for, not every new `restapi` feature. Bumped the `@rapidmx/restapi` dependency to `0.3.x`/`^0.3.1`.

- **Scoping pass first, before writing any code**: most of the new surface has no EAS wire equivalent at all
  and was deliberately left alone - `TransportRule`/`MailFilterRule` (no rules-management command in this
  library's MS-ASCMD subset), `Domain`/DNS setup/`Branding`/`AuditLogEntry` (admin/server config, never
  device-facing), Focused Inbox classification (an Outlook/OWA concept with no MS-ASEMAIL field), resource
  auto-accept and iTIP invite generation (transparent at the SMTP/calendar-sync level already - the resulting
  `CalendarEvent` just shows up via ordinary `Sync`), `Message.recall()` (no MS-ASCMD analog), plus-addressing
  and MDN receipts (transparent at delivery time, nothing for a device to see or set). `Contact.favorite`/
  `Task.myDay` also have no MS-ASCONTACTS/MS-ASTASK wire field to land on - left unmapped, matching this
  library's own precedent of documenting a gap rather than inventing a field.
- **`Contact.categories` (new `restapi` field) → MS-ASCONTACTS `Categories`/`Category`** in
  `ContactsSyncAdapter`, both directions. Ghosted as its own whole group, same rule as `emails`/`phones`/
  `addresses`: absent `Categories` element leaves it untouched, a present one (even empty) rebuilds it.
- **`Message.conversationId` (new `restapi` field) → MS-ASEMAIL2 `Email2:ConversationId`**, read-only, in
  `EmailSyncAdapter.toApplicationData`. Encoded as the uid's own UTF-8 bytes in a WBXML `OPAQUE` element
  (`encodeConversationId`/`decodeConversationId`, now exported from `EmailSyncAdapter.ts`) rather than hashed
  into a 16-byte GUID shape - the spec never mandates a particular binary format, a device only ever compares/
  echoes the value byte-for-byte, and this way `decodeConversationId` inverts it exactly.
- **Closed `ItemOperationsCommand`'s own long-documented gap**: conversation `Move` ("this library has no
  conversation-grouping concept for `Message` at all") is now implemented, using the `ConversationId` decoded
  the same way. Every `Message` sharing the decoded `conversationId` across the *whole mailbox* (not just one
  folder - a conversation can span folders) that the caller has `UPDATE` on is relocated to `DstFldId`; one
  lacking permission is silently skipped rather than failing the whole move (mirrors a shared-folder scenario,
  not a new pattern). `MoveAlways` is accepted but not acted on - no conversation-scoped `MailFilterRule`
  condition exists to key an ongoing rule off of; documented, not silent data loss (the move itself still
  happens). Query is deliberately scoped to `ctx.mailboxUid`: `conversationId` is derived from the RFC 5322
  thread (`References`/`In-Reply-To`/`Message-ID`), which can genuinely collide across two different mailboxes
  that both received the same thread - unscoped, a `Move` could reach into a mailbox that never even
  participated in the request.
- **Real bug found and fixed, outside this repo's own code**: `@rapidrest/service-core`'s `test/request.js`
  (the `request()`/`agent()` helper every route-level test in this repo uses) configures its underlying axios
  client with `responseType: "text"`, which silently replaces any response byte sequence that isn't valid
  UTF-8 with U+FFFD *before the test ever sees it* - corrupting the WBXML `OPAQUE` token itself (`0xC3`) in any
  response carrying real binary content. This is why `ItemOperationsCommand.fetchAttachment` was already
  base64-text-encoding attachment `Data` instead of using this codec's own `opaqueElement` for it - sidesteps
  this exact test-harness limitation (whether or not that was the original reason, it has the same effect).
  Confirmed the corruption is test-harness-only, not a wire-format bug: reproduced the exact byte-for-byte
  round trip correctly through raw `uWebSockets.js` directly (`res.end(buffer)` preserves arbitrary bytes
  fine) - a real device's own HTTP stack is unaffected. Didn't touch the sibling `service-core` checkout for
  this (out of scope, not asked); instead added a `postWbxmlBinary` helper to both `test/routes/{mongo,sql}/
  EasRoute.test.ts` that reads the response over a raw Node `http` socket, used only by the handful of new
  tests that assert on `ConversationId`'s exact opaque byte content - every other test's response content is
  plain text and unaffected by the bug, so `postWbxml` (via the shared helper) stays the default.
- Also found and cleaned up: two stale, gitignored `rrst-test`/`rrst-test-acl` SQLite files at the repo root
  left over from a session predating the `restapi` 0.3.x bump - `ec7d387` (receipts) added several new
  required `Mailbox` boolean columns with no SQL-level `DEFAULT`, so `TypeORM`'s `ADD COLUMN` migration against
  those stale files' pre-existing rows failed with `NOT NULL constraint failed`. Not a real bug (a fresh test
  DB never hits this), just a local artifact; deleting them let `synchronize()` create the columns correctly
  from scratch. Worth knowing if this resurfaces: it means a real deployment doing an in-place `synchronize()`
  upgrade across this specific `restapi` version bump would hit the same failure against a populated `Mailbox`
  table - a `restapi`-side migration concern, not this repo's.

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

### 2026-09-07 — Adversarial two-agent code review, 7 confirmed findings fixed

JP asked for a full code review via two adversarial agents (one security-lens, one correctness-lens),
reviewing all of `src/` independently in parallel, followed by manual verification of every claim against the
actual source before trusting it (two low-confidence agent claims didn't survive verification and were
dropped). Then fixed the whole confirmed list, one commit per finding/theme:

- **CRITICAL, fixed**: `SyncCommand.applyChange`/`applyDelete` resolved a client-supplied `ServerId` via
  `repo.findOne(ignoreACL:true)` and mutated/deleted it with **no ACL check and no ownership verification at
  all** - a device could target another mailbox's item by uid. `computeChanges()` had the identical gap for
  reads (a crafted `CollectionId` belonging to another mailbox's folder returned that folder's full content).
  This was the one place in the codebase that dropped the "ACL-check after an `ignoreACL` lookup" pattern every
  sibling command (`ItemOperationsCommand`, `MoveItemsCommand`) already used consistently - not a new pattern
  invented for the fix, a restored one. Now requires `READ` on the folder before touching anything in
  `processCollection()`, `CREATE`/`UPDATE`/`DELETE` respectively in `applyAdd`/`applyChange`/`applyDelete`, and
  `applyChange`/`applyDelete` re-verify the resolved item's own `folderUid` matches (treated as "not found",
  never distinguishable from a genuinely missing item).
- **HIGH, fixed**: `GetItemEstimateCommand` had the identical missing-ownership-check root cause for its own
  `CollectionId` - smaller blast radius (a count leak, not content).
- **MEDIUM, fixed**: `EmailSyncAdapter.buildPlainTextMime()` interpolated client-supplied Subject/To/Cc
  directly into RFC 5322 header lines with no CRLF sanitization - `WbxmlDecoder.readCString()` only stops at a
  NUL byte, so literal `\r\n` bytes in a decoded string survive untouched, enabling header injection into a
  stored Draft's MIME (and whatever gets sent later, if that draft is sent for real).
  Fixed with a `sanitizeHeaderValue()` fold-to-single-line helper at the actual interpolation sink.
- **MEDIUM, fixed**: `ItemOperationsCommand.fetchMessage()` computed `EstimatedDataSize` from the body *after*
  truncation, contrary to MS-ASAIRSYNCBASE (should be the pre-truncation size) - captured before truncation now.
- **LOW/moderate DoS, fixed**: `WbxmlDecoder`'s `readTagElement`/`readContentUntilEnd` recursed with no depth
  cap (unlike every length-prefixed field in the format) - ~2 bytes of wire format per nesting level could
  drive a stack-overflow `RangeError` from a tiny request. Added `MAX_NESTING_DEPTH = 200`.
- **LOW, fixed**: `SearchCommand`'s `Range` element built `${start}-${Math.min(end, matches.length - 1)}`,
  producing the malformed `"0--1"` when a GAL search matched zero contacts. Clamped to 0.
- **LOW, fixed**: `SyncCommand.applyDelete` captured its watermark via `new Date()` *before* the actual
  `repo.delete()` call - moved to after the write resolves, so the persisted SyncKey watermark can no longer
  understate the delete's real effective time (was causing occasional harmless duplicate Delete redelivery).
- **Two agent claims did NOT survive verification** and were dropped rather than reported: a "narrow duplicate
  Add" race in `EasSyncKeyUtils.computeChanges()`'s 1-second newly-created tolerance window (requires two writes
  within ~100ms of each other spanning two sync rounds - real but practically unreachable), and a claim that
  `EasCommandContext.policyKey` being unchecked was a live vulnerability (it's already self-documented in that
  interface's own doc comment as a deferred, known gap - re-flagging your own documented TODO isn't a finding).

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
