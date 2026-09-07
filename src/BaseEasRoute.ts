///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    HttpRequest,
    HttpResponse,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { WbxmlDecoder } from "./codec/WbxmlDecoder.js";
import { WbxmlEncoder } from "./codec/WbxmlEncoder.js";
import type { WbxmlElement } from "./codec/WbxmlElement.js";
import type { EasCommandHandler } from "./EasCommandHandler.js";
import { DeviceSyncState, Mailbox, resolveCallerMailboxUid } from "@rapidmx/restapi";
const { Init, Logger } = ObjectDecorators;
const { Auth, Post, Request, Response, User: AuthUser } = RouteDecorators;

/** HTTP 449 ("Retry With") is not a standard HTTP status, but is the long-established Exchange ActiveSync
 * convention a real client recognizes as "you must successfully complete `Provision` before this command will
 * be honored" - simpler than constructing a command-specific WBXML error body for every possible command a
 * client might send before it's provisioned. */
const HTTP_STATUS_RETRY_WITH = 449;

function firstQueryValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Abstract base for the single fixed EAS endpoint (`POST /Microsoft-Server-ActiveSync` by MS-ASHTTP
 * convention, though the concrete path is left to the consuming application to mount via `@Route(...)` — see
 * `BaseMailIngestRoute.ts` for the identical undecorated-base-class pattern this follows). Unlike every other
 * route in this library, EAS dispatches on a `Cmd` query parameter against one URL rather than path-based REST
 * routing, so there is exactly one `@Post()` method here, not one per operation.
 *
 * **Auth**: `@Auth(["jwt"])` — the framework's own default strategy, unchanged from every other route in this
 * app. A real native EAS client obtaining that JWT in the first place (rather than the app's own web/API
 * clients, which already have one) requires an OAuth 2.0 Authorization Server capability this library
 * deliberately does not implement itself — see the architecture plan's "Auth" section for the full reasoning
 * behind this choice over a per-request Basic Auth strategy.
 *
 * **Dispatch flow**: resolve the caller's own `Mailbox` (never a client-supplied one — `resolveCallerMailboxUid`,
 * the same helper `BaseSearchRoute` already uses), find-or-create that (mailbox, device) pair's
 * `DeviceSyncState`, enforce the provisioning gate, decode the WBXML request body (if any), dispatch to the
 * matching registered `EasCommandHandler`, bump `lastSyncAt`, and encode the handler's response back to WBXML.
 *
 * **Command handlers** are supplied via `commandHandlerClasses` (empty by default — this class alone is just
 * the transport skeleton; concrete command support, e.g. `ProvisionCommand`/`FolderSyncCommand`, is added
 * incrementally in later work by having a concrete subclass populate this array) and instantiated once each in
 * `@Init` via `ObjectFactory`, so a handler can `@Inject` its own dependencies like any other DI-managed class
 * in this library.
 *
 * **KNOWN LIMITATION - no `OPTIONS` protocol discovery**: real EAS clients conventionally probe `OPTIONS`
 * before their first `POST` to read `MS-ASProtocolVersions`/`MS-ASProtocolCommands` and learn what the server
 * supports. This class deliberately does not implement that: `Server.ts`'s global CORS middleware
 * unconditionally intercepts every `OPTIONS` request (any method, any path) with a bare `204` before request
 * handling ever reaches an app-registered route — confirmed by reading `Server.ts` and by a real HTTP-level
 * test against this exact route, not assumed — so an app-level `@Options()` handler here would be genuine
 * dead code, never actually invoked. Fixing this properly belongs in `service-core`'s CORS middleware (e.g.
 * only short-circuiting when no matching route registers its own `OPTIONS` handler), a cross-cutting change
 * affecting every app on this framework, not something to work around locally in one route. Real-device
 * testing (this phase's own next milestone gate) will show whether a client actually depends on this
 * discovery step or tolerates a manually-configured server address without it.
 *
 * `deviceSyncStateClass`/`mailboxClass` are supplied by the Mongo/SQL concrete subclasses, following the exact
 * one-line-per-backend pattern used throughout this library's other routes/jobs.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseEasRoute<D extends DeviceSyncState, M extends Mailbox = Mailbox> {
    protected abstract deviceSyncStateClass: any;
    protected abstract mailboxClass: any;

    /** Command handler classes to instantiate (one each) in `@Init`. Empty until a concrete command lands -
     * every request is then answered with HTTP 501 (see `dispatch()`), which is the correct, honest behavior
     * for a transport skeleton with no commands implemented yet, not a bug to work around. */
    protected commandHandlerClasses: any[] = [];

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private deviceSyncStateRepo?: RepoUtils<D>;
    private mailboxRepo?: RepoUtils<M>;
    private readonly handlers = new Map<string, EasCommandHandler>();

    @Logger
    private logger: any;

    @Init
    public async init(): Promise<void> {
        this.deviceSyncStateRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.deviceSyncStateClass.name,
            args: [this.deviceSyncStateClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        for (const HandlerClass of this.commandHandlerClasses) {
            const handler: EasCommandHandler = await this._objectFactory!.newInstance(HandlerClass);
            this.handlers.set(handler.command, handler);
        }
    }

    @Auth(["jwt"])
    @Post()
    public async dispatch(@Request req: HttpRequest, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<void> {
        if (!this.deviceSyncStateRepo || !this.mailboxRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const cmd: string | undefined = firstQueryValue(req.query["Cmd"]);
        const deviceId: string | undefined = firstQueryValue(req.query["DeviceId"]);
        const deviceType: string = firstQueryValue(req.query["DeviceType"]) ?? "Unknown";
        const policyKey: string | undefined = firstQueryValue(req.query["PolicyKey"]);
        if (!cmd || !deviceId) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const mailboxUid: string | undefined = await resolveCallerMailboxUid(this.mailboxRepo, user);
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const deviceSyncState: D = await this.findOrCreateDeviceSyncState(mailboxUid, deviceId, deviceType);

        // Every command except the two that must work on an unprovisioned device (Provision itself, and
        // Settings - real clients query Settings/DeviceInformation as part of first-run setup, before
        // provisioning completes) requires the device to have already been provisioned.
        if (!deviceSyncState.provisioned && cmd !== "Provision" && cmd !== "Settings") {
            res.status(HTTP_STATUS_RETRY_WITH).send();
            return;
        }

        const handler: EasCommandHandler | undefined = this.handlers.get(cmd);
        if (!handler) {
            res.status(501).send();
            return;
        }

        const request: WbxmlElement | undefined =
            req.rawBody && req.rawBody.length > 0 ? new WbxmlDecoder().decode(req.rawBody) : undefined;

        const response: WbxmlElement | undefined = await handler.handle({
            user,
            mailboxUid,
            deviceId,
            deviceType,
            policyKey,
            deviceSyncState,
            deviceSyncStateRepo: this.deviceSyncStateRepo,
            query: req.query,
            request,
            req,
        });

        await this.deviceSyncStateRepo.update(
            { uid: deviceSyncState.uid, version: (deviceSyncState as any).version, lastSyncAt: new Date() } as any,
            deviceSyncState,
            { ignoreACL: true, skipPush: true },
        );

        if (!response) {
            res.status(200).send();
            return;
        }

        const buffer: Buffer = new WbxmlEncoder().encode(response);
        res.setHeader("Content-Type", "application/vnd.ms-sync.wbxml")
            .setHeader("Content-Length", buffer.length)
            .status(200)
            .send(buffer);
    }

    private async findOrCreateDeviceSyncState(mailboxUid: string, deviceId: string, deviceType: string): Promise<D> {
        const existing: D[] = await this.deviceSyncStateRepo!.find(
            { mailboxUid, deviceId },
            { ignoreACL: true, limit: 1 },
        );
        if (existing[0]) {
            return existing[0];
        }
        const instance: D = this.deviceSyncStateRepo!.instantiateObject({
            mailboxUid,
            deviceId,
            deviceType,
            folderSyncKeys: {},
            provisioned: false,
        });
        return await this.deviceSyncStateRepo!.create(instance, { ignoreACL: true });
    }
}
