///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { JWTUser } from "@rapidrest/core";
import type { HttpRequest, RepoUtils } from "@rapidrest/service-core";
import type { WbxmlElement } from "./codec/WbxmlElement.js";
import type { DeviceSyncState } from "./models/DeviceSyncState.js";

/**
 * Everything an `EasCommandHandler` needs to process one dispatched EAS command — assembled once by
 * `BaseEasRoute.dispatch()` per request and handed to whichever handler matches `?Cmd=`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EasCommandContext {
    /** The authenticated caller, per the same `@AuthUser` JWT payload every other route in this library reads. */
    readonly user: JWTUser;
    /** The `Mailbox` this request operates against — resolved server-side from `user` (`ownerUserUid`), never
     * taken from client input. */
    readonly mailboxUid: string;
    /** The client-supplied `?DeviceId=` query value, identifying this device within the mailbox. */
    readonly deviceId: string;
    /** The client-supplied `?DeviceType=` query value (e.g. `iPhone`, `Android`). */
    readonly deviceType: string;
    /** The client-supplied `?PolicyKey=` query value, if present - the provisioning policy key the device is
     * currently operating under. Not yet validated against `deviceSyncState.policyKey` here (deferred to
     * `ProvisionCommand`'s own implementation); handlers that care should compare it themselves for now. */
    readonly policyKey?: string;
    /** This device's persisted sync/provisioning state, looked up (or newly created) by `BaseEasRoute` before
     * dispatch. Handlers read/write cursor and provisioning fields on this directly. */
    readonly deviceSyncState: DeviceSyncState;
    /** The live repo backing `deviceSyncState`'s concrete entity class, for handlers that need to persist a
     * change to it (e.g. a new `SyncKey`, an updated `policyKey`, flipping `provisioned`). Typed `RepoUtils<any>`
     * rather than `RepoUtils<DeviceSyncState>` deliberately - `RepoUtils<D>`'s underlying TypeORM `Repository<D>`
     * is not covariant in `D` (a handful of its methods, e.g. `sum()`, use `D`-dependent conditional types), so
     * `BaseEasRoute`'s own `RepoUtils<D>` (for its concrete `D extends DeviceSyncState`) cannot be narrowed to
     * this field's type without `any` somewhere in between. */
    readonly deviceSyncStateRepo: RepoUtils<any>;
    /** Every query-string parameter on the request, for the handful of commands with additional command-
     * specific query parameters beyond the common four already broken out above. */
    readonly query: Record<string, string | string[]>;
    /** The decoded WBXML request body, or `undefined` for a command sent with an empty body (legal for a few
     * commands, e.g. a bare `GetItemEstimate`-less `Ping` continuation). */
    readonly request?: WbxmlElement;
    /** The raw underlying HTTP request, for the rare handler that needs something this context doesn't
     * already surface (e.g. a header). */
    readonly req: HttpRequest;
}

/**
 * One EAS protocol command (`Provision`, `FolderSync`, `Sync`, ...). `BaseEasRoute` builds one instance of
 * each registered handler class in its own `@Init` (via `ObjectFactory`, so a handler can `@Inject` its own
 * dependencies exactly like any other DI-managed class in this library) and dispatches to the one whose
 * `command` matches the request's `?Cmd=` value.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EasCommandHandler {
    /** The exact `?Cmd=` value this handler answers to (e.g. `"FolderSync"`). */
    readonly command: string;
    /** Processes the command and returns the WBXML element tree to send back as the response body, or
     * `undefined` for a command whose successful response is legitimately empty. */
    handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined>;
}
