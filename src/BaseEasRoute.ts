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
import { WbxmlDecodeError, WbxmlDecoder } from "./codec/WbxmlDecoder.js";
import { WbxmlEncoder } from "./codec/WbxmlEncoder.js";
import type { WbxmlElement } from "./codec/WbxmlElement.js";
import type { EasCommandHandler } from "./EasCommandHandler.js";
import { persistDeviceSyncState } from "./EasSyncKeyUtils.js";
import { Mailbox, resolveCallerMailboxUid } from "@rapidmx/restapi";
import { DeviceSyncState } from "./models/DeviceSyncState.js";
const { Config, Init, Logger } = ObjectDecorators;
const { Auth, Options, Post, Request, Response, User: AuthUser } = RouteDecorators;

/** HTTP 449 ("Retry With") is not a standard HTTP status, but is the long-established Exchange ActiveSync
 * convention a real client recognizes as "you must successfully complete `Provision` before this command will
 * be honored" - simpler than constructing a command-specific WBXML error body for every possible command a
 * client might send before it's provisioned. */
const HTTP_STATUS_RETRY_WITH = 449;

/** `MS-ASProtocolVersions` value this library actually implements against: confirmed via `[MS-ASHTTP]` that
 * "14.0"/"14.1" are the versions whose `ComposeMail`/`Email2` WBXML code pages cover MIME-based
 * `SendMail`/`SmartForward`/`SmartReply` (what `ComposeMailCommand` actually sends) - not 12.x (which predates
 * MIME-based compose). `16.0`/`16.1` are now included too, now that `SettingsCommand` implements `Oof` (their
 * other headline addition, `RightsManagementInformation`, remains unimplemented, but that alone doesn't gate
 * the version string - `MS-ASProtocolCommands` below is the real capability gate, derived live from
 * `this.handlers`, so a client probing capabilities correctly sees any specific unsupported command regardless
 * of which protocol versions are declared, exactly as it already does for `GetItemEstimate`/`MoveItems`/
 * `ResolveRecipients`). No MS-ASCMD `Sync`/`FolderSync`/`Provision` schema element became newly mandatory
 * between 14.1 and 16.1 outside `Oof`/IRM. Ascending, matching the order Microsoft's own spec lists them in. */
const MS_AS_PROTOCOL_VERSIONS = "14.0,14.1,16.0,16.1";

/** Default `mail:eas:max_request_bytes` - comfortably above a real device's largest request (a `SendMail` with
 * attachments), far below the host-wide body limit. The WBXML decoder's own element limits bound memory further. */
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** Commands a device may send before it is provisioned (and without a policy key). */
const COMMANDS_WITHOUT_PROVISIONING = new Set(["Provision", "Settings"]);

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
 * **Dispatch flow**: reject a body over `mail:eas:max_request_bytes` (413), resolve the caller's own `Mailbox` (never
 * a client-supplied one — `resolveCallerMailboxUid`), find-or-create that (mailbox, device) pair's `DeviceSyncState`,
 * enforce the provisioning gate (provisioned *and* presenting the stored policy key, else 449), decode the WBXML
 * request body (if any; malformed or over the decoder's element limits -> 400), dispatch to the matching registered
 * `EasCommandHandler`, record `lastSyncAt` (best-effort), and encode the handler's response back to WBXML.
 *
 * **Command handlers** are supplied via `commandHandlerClasses` (empty by default — this class alone is just
 * the transport skeleton; concrete command support, e.g. `ProvisionCommand`/`FolderSyncCommand`, is added
 * incrementally in later work by having a concrete subclass populate this array) and instantiated once each in
 * `@Init` via `ObjectFactory`, so a handler can `@Inject` its own dependencies like any other DI-managed class
 * in this library.
 *
 * **`OPTIONS` protocol discovery**: real EAS clients conventionally probe `OPTIONS` before their first `POST`
 * to read `MS-ASProtocolVersions`/`MS-ASProtocolCommands` and learn what the server supports - see `options()`
 * below. This requires `@rapidrest/service-core` >=1.5.0, whose global CORS middleware consults
 * `IHttpRouter.hasExplicitOptionsRoute()` before its blanket preflight `204` - confirmed live end to end
 * against a real `service-core` 1.5.0 install (`test/routes/{mongo,sql}/EasRoute.test.ts`'s `OPTIONS`
 * describe block), not assumed.
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

    /** Largest request body `dispatch()` accepts (HTTP 413 beyond it). */
    @Config("mail:eas:max_request_bytes", DEFAULT_MAX_REQUEST_BYTES)
    private maxRequestBytes: number = DEFAULT_MAX_REQUEST_BYTES;

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

    /**
     * Answers a real client's pre-flight `MS-ASProtocolVersions`/`MS-ASProtocolCommands` capability probe -
     * see this class's own doc comment for the `service-core` version dependency this needs to actually run.
     * Deliberately unauthenticated (no `@Auth`): this is capability discovery, not mailbox access, and a real
     * Exchange server answers it the same way regardless of credentials. `MS-ASProtocolCommands` is built from
     * `this.handlers`, not a separately-maintained list, so it can never drift out of sync with the commands a
     * concrete subclass actually registered via `commandHandlerClasses`.
     */
    @Options()
    public async options(@Response res: HttpResponse): Promise<void> {
        res.setHeader("MS-ASProtocolVersions", MS_AS_PROTOCOL_VERSIONS)
            .setHeader("MS-ASProtocolCommands", Array.from(this.handlers.keys()).join(","))
            .status(200)
            .send();
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

        // service-core has no per-route body limit, so the host-wide `max_body_size` still bounds how much was
        // read; this rejects anything beyond the (much lower) EAS limit before any decoding or database work.
        const declaredLength = Number(firstQueryValue(req.headers["content-length"]));
        if ((Number.isFinite(declaredLength) && declaredLength > this.maxRequestBytes) || (req.rawBody?.length ?? 0) > this.maxRequestBytes) {
            res.status(413).send();
            return;
        }

        const mailboxUid: string | undefined = await resolveCallerMailboxUid(this.mailboxRepo, user);
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const deviceSyncState: D = await this.findOrCreateDeviceSyncState(mailboxUid, deviceId, deviceType);

        // Every command except the two that must work on an unprovisioned device (Provision itself, and
        // Settings - real clients query Settings/DeviceInformation as part of first-run setup, before
        // provisioning completes) requires the device to be provisioned AND to present the policy key it
        // acknowledged ([MS-ASPROV]: `X-MS-PolicyKey`, or the `PolicyKey` query value). A missing or stale key -
        // e.g. one from before an admin-requested remote wipe, which clears the stored key - is sent back through
        // Provision with the same 449 rather than being served.
        if (!COMMANDS_WITHOUT_PROVISIONING.has(cmd)) {
            const presentedKey: string | undefined = firstQueryValue(req.headers["x-ms-policykey"]) ?? policyKey;
            if (!deviceSyncState.provisioned || !deviceSyncState.policyKey || presentedKey !== deviceSyncState.policyKey) {
                res.status(HTTP_STATUS_RETRY_WITH).send();
                return;
            }
        }

        const handler: EasCommandHandler | undefined = this.handlers.get(cmd);
        if (!handler) {
            res.status(501).send();
            return;
        }

        let request: WbxmlElement | undefined;
        try {
            request = req.rawBody && req.rawBody.length > 0 ? new WbxmlDecoder().decode(req.rawBody) : undefined;
        } catch (err) {
            if (err instanceof WbxmlDecodeError) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `Malformed WBXML request: ${err.message}`);
            }
            throw err;
        }

        const response: WbxmlElement | undefined = await handler.handle({
            user,
            mailboxUid,
            deviceId,
            deviceType,
            policyKey: firstQueryValue(req.headers["x-ms-policykey"]) ?? policyKey,
            deviceSyncState,
            deviceSyncStateRepo: this.deviceSyncStateRepo,
            query: req.query,
            request,
            req,
            res,
        });

        // Bookkeeping only - the command already ran, so failing to record the timestamp must never turn a
        // successful response into an error.
        try {
            await persistDeviceSyncState(deviceSyncState, this.deviceSyncStateRepo, { lastSyncAt: new Date() });
        } catch (err: any) {
            this.logger?.warn(`BaseEasRoute: failed to record lastSyncAt for device ${deviceId}: ${err?.message}`);
        }

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
