///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Exchange ActiveSync protocol compatibility (Phase 2 of this library's roadmap): a WBXML codec, JWT-secured
 * transport (`BaseEasRoute`, reusing the framework's existing `@Auth(["jwt"])` strategy - no EAS-specific auth
 * code of its own), and the pragmatic command subset agreed in the architecture plan - `Provision`,
 * `FolderSync`, `Sync` (`Email`/`Contacts`/`Calendar`/`Tasks`), `SendMail`/`SmartForward`/`SmartReply`,
 * `ItemOperations`, `Ping`, `Search` (GAL), `MeetingResponse`, and `Settings`.
 *
 * This module exports only the backend-agnostic surface: the codec, the abstract route/command base classes,
 * the shared sync-cursor/date-format utilities, and the `Sync` collection adapters. The concrete Mongo/SQL
 * classes a deployment actually instantiates (`EasRouteMongo`/`EasRouteSQL` and each command's Mongo/SQL
 * variant) are exported from this package's `./mongo`/`./sql` subpaths instead, alongside every other
 * entity/route/job this library defines - see `MongoConnection`/`ConnectionManager` usage elsewhere in this
 * library's own README for that convention.
 *
 * A deployment mounts EAS at the protocol's well-known path with a trivial one-line subclass, the same pattern
 * `push/MailPushRoute.ts`'s doc comment describes for `BasePushRoute`:
 * ```ts
 * import { EasRouteMongo } from "@rapidrest/mail/mongo";
 * import { RouteDecorators } from "@rapidrest/service-core";
 * const { Route } = RouteDecorators;
 *
 * @Route("/Microsoft-Server-ActiveSync")
 * export class MyEasRoute extends EasRouteMongo {}
 * ```
 */
export * from "./codec/WbxmlCodePages.js";
export * from "./codec/WbxmlElement.js";
export * from "./codec/WbxmlEncoder.js";
export * from "./codec/WbxmlDecoder.js";
export * from "./BaseEasRoute.js";
export * from "./EasCommandHandler.js";
export * from "./EasSyncKeyUtils.js";
export * from "./CompactDateTime.js";
export * from "./commands/ProvisionCommand.js";
export * from "./commands/FolderSyncCommand.js";
export * from "./commands/SyncCommand.js";
export * from "./commands/ComposeMailCommand.js";
export * from "./commands/SendMailCommand.js";
export * from "./commands/SmartForwardCommand.js";
export * from "./commands/SmartReplyCommand.js";
export * from "./commands/PingCommand.js";
export * from "./commands/ItemOperationsCommand.js";
export * from "./commands/SearchCommand.js";
export * from "./commands/MeetingResponseCommand.js";
export * from "./commands/SettingsCommand.js";
export * from "./adapters/EasCollectionSyncAdapter.js";
export * from "./adapters/EmailSyncAdapter.js";
export * from "./adapters/ContactsSyncAdapter.js";
export * from "./adapters/CalendarSyncAdapter.js";
export * from "./adapters/TasksSyncAdapter.js";
