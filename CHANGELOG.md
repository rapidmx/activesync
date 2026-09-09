# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-beta.0] - 2026-09-09

### Added
- Added real OPTIONS capability discovery (MS-ASProtocolVersions/MS-ASProtocolCommands)
- Added Settings Oof support, bump declared protocol versions to 16.0/16.1
- Added WBXML tag tables for Move, ItemEstimate, ResolveRecipients
- Added GetItemEstimate, MoveItems, and ResolveRecipients commands
- Added multi-Fetch, BodyPreference/truncation, and EmptyFolderContents to ItemOperations
- Added Provision policy enforcement, RemoteWipe flow, and admin trigger route
- Added changelog, contributing, contributors, release notes files
- Added Contact.categories support to ContactsSyncAdapter via MS-ASCONTACTS Categories/Category, both directions
- Added Message.conversationId to EmailSyncAdapter as MS-ASEMAIL2 Email2:ConversationId, encoded as opaque UTF-8 bytes
- Added ItemOperationsCommand support for conversation Move, closing this repo's own documented no-conversation-grouping gap
- Added postWbxmlBinary test helper to both EasRoute test suites, working around @rapidrest/service-core's test request() helper corrupting binary WBXML OPAQUE content via its responseType: text axios config
- Added a per-request cap on ItemOperations Fetch elements and batch the unbounded queries in emptyFolderContents/moveConversation to bound memory and round-trips

### Changed
- Initial commit
- Requires the matching service-core CORS middleware fix to actually run - documented in NOTES.md/README
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Accept client-originated Sync Add/Change/Delete for Contacts/Calendar/Tasks
- SyncCommand previously never read the request's own <Commands> element, so a
- device creating/editing/deleting a Contact, Calendar event, or Task directly
- (the normal way a phone's native apps behave against an EAS account) was
- silently dropped. Email now accepts Delete only, since [MS-ASCMD] itself
- disallows non-draft Add and composing/sending goes through SendMailCommand.
- EasCollectionSyncAdapter gains two optional members (fromApplicationData,
- newEntityDefaults) implemented for Contacts/Calendar/Tasks; their absence on
- EmailSyncAdapter is the capability gate SyncCommand uses to answer Status 6,
- rather than a separate flag that could drift. SyncCommand's own @Init now
- builds RecoverableRepoUtils instead of plain RepoUtils, since it originates
- its own soft-deletes.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Add persistDeviceSyncState() to apply a patch and copy back the repo's returned version, since RepoUtils.update() never mutates its `existing` argument
- - Fix ProvisionCommand/FolderSyncCommand/SyncCommand/BaseEasRoute to use it instead of discarding the returned instance
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Bump @rapidmx/restapi to 0.2.x for new DeviceSyncState/Mailbox fields
- - Consume folderCollectionClasses/RemoteWipe fields on DeviceSyncState and Oof fields on Mailbox
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgrade to service-core 1.5.0, making OPTIONS discovery actually run
- - Bump dependency to pick up hasExplicitOptionsRoute()
- - Update EasRoute OPTIONS integration tests to verify live behavior instead of documenting it as dead code
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Support multiple Collections per Sync request
- - Restructure SyncCommand.handle() to process every <Collection>, not just the first
- - Batch all SyncKey/Class writes into a single persistDeviceSyncState call per request
- - Remember a collection's Class in DeviceSyncState.folderCollectionClasses so later requests may omit it
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Instantiate Sync collection adapters via DI, widen adapter interface
- - SyncCollectionBinding carries adapterClass instead of a pre-built instance, resolved via ObjectFactory
- - Widen EasCollectionSyncAdapter: fromApplicationData may return a Promise, newEntityDefaults() takes the caller's Mailbox
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Support Email Draft creation/editing via Sync Add/Change
- - Implement EmailSyncAdapter.fromApplicationData/newEntityDefaults for plain-text Draft bodies
- - Wrap a Draft's body in a minimal RFC 5322 message so ItemOperations Fetch still parses it correctly
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Delete the calendar item on MeetingResponse decline
- - Soft-delete the CalendarEvent instead of just flipping Attendee.responseStatus, matching real Exchange behavior
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Implement SettingsCommand Oof Get/Set backed by new Mailbox oof* fields
- - Declare MS-ASProtocolVersions 16.0/16.1 now that Oof is implemented
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Add tag tables sourced from Z-Push's wbxmldefs.php for the three previously enum-only code pages
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Add GetItemEstimateCommand (read-only per-collection change count estimate)
- - Add MoveItemsCommand (moves a Message between folders in the caller's own mailbox)
- - Add ResolveRecipientsCommand (resolves a To value against the mailbox's own GAL/Contact store)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Update README/NOTES.md for the practical-full-compliance work so far
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Loop over every <Fetch> instead of only the first
- - Honor Options/BodyPreference (Type 4 raw MIME, others truncate with Truncated set)
- - Reject Fetch Store="DocumentLibrary" with 400
- - Implement EmptyFolderContents, rejecting DeleteSubFolders
- - Correct plan assumptions on Store/Move per MS-ASCMD's published XSD - Store is a Fetch selector, not a write op; conversation Move is out of scope
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Source password/encryption policy from @Config instead of a hardcoded permissive document
- - Reject phase-2 acknowledgement when the client's own Policy Status isn't "1"
- - Implement the three-step RemoteWipe flow on the existing DeviceSyncState fields and 449 gate
- - Add BaseDeviceSyncStateRoute (POST /:uid/remote-wipe) as the admin trigger
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Require ACLAction.READ on the folder before enumerating or accepting Commands
- - Require CREATE/UPDATE/DELETE before Add/Change/Delete actually writes
- - Re-verify a resolved item's folderUid matches the collection being synced, treating a mismatch as not-found
- - Capture applyDelete's watermark after the write resolves instead of before
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Add sanitizeHeaderValue() to fold embedded CR/LF before interpolating client input into MIME headers
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Cap WBXML decoder nesting depth to prevent stack-exhaustion DoS
- - Add MAX_NESTING_DEPTH (200) tracked across readTagElement()/readContentUntilEnd()'s recursion
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - GetItemEstimateCommand: require ACLAction.READ on the folder before counting
- - ItemOperationsCommand: compute EstimatedDataSize before truncation, not after
- - SearchCommand: fix malformed "0--1" Range on zero matches
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - SearchCommand: clamp Range start too, not just end, on zero matches
- - SettingsCommand/TasksSyncAdapter: clear optional dates with null instead of undefined so SQL actually clears them
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgraded all dependencies
- Updated CI workflows
- Updated claude commit instructions
- Upgraded @rapidmx/restapi
- Bump @rapidmx/restapi to 0.3.x, catching up to its new Contact.categories and Message.conversationId fields
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed silent no-op when DeviceSyncState is written twice in one request
- Fixed cross-mailbox IDOR in Sync Change/Delete and folder read enumeration
- Fixed CRLF header injection in Draft MIME construction
- Fixed GetItemEstimate cross-mailbox leak, EstimatedDataSize, and empty-result Range
- Fixed incomplete Search Range clamp and SQL undefined-clearing gaps
- Fixed ItemOperationsCommand.moveConversation reporting Status 1 success when every message lacked UPDATE permission and nothing actually moved
- Fixed PingCommand subscribing to client-supplied folder uids with no ACL check, letting a device keep watching a folder's activity after its access was revoked
- Fixed EmailSyncAdapter ghosting To/Cc as one combined group instead of independently, silently dropping the untouched type on a partial Change, and add missing Bcc support in both directions
- Fixed SyncCommand.applyDelete approximating its watermark with wall-clock time instead of the deleted row's own persisted dateModified, which could let a concurrent unrelated write in the same folder be permanently skipped

### Removed
- Removed unused files

[Unreleased]: https://github.com/RapidMX/activesync/compare/v1.0.0-beta.0...HEAD
[1.0.0-beta.0]: https://github.com/RapidMX/activesync/releases/tag/v1.0.0-beta.0
