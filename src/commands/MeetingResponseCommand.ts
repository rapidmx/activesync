///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { AttendeeResponseStatus, type CalendarEvent, type Mailbox, RecoverableRepoUtils } from "@rapidmx/restapi";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Init, Inject } = ObjectDecorators;

/** MS-ASCMD `UserResponse`: 1=Accepted, 2=Tentatively accepted, 3=Declined. */
const USER_RESPONSE_STATUS: Record<string, AttendeeResponseStatus> = {
    "1": AttendeeResponseStatus.ACCEPTED,
    "2": AttendeeResponseStatus.TENTATIVE,
    "3": AttendeeResponseStatus.DECLINED,
};

const USER_RESPONSE_DECLINED = "3";

/**
 * Handles EAS `MeetingResponse`: records the caller's own accept/tentative/decline response to a meeting on
 * the referenced `CalendarEvent`. `RequestId` is the same `Message`/`CalendarEvent.uid` this library already
 * exposes as `ServerId` elsewhere (Sync/FolderSync) - no separate lookup table is needed.
 *
 * **Pragmatic subset**: only the first `<Request>` in the command is processed (the real spec allows several
 * per request, matching `Sync`'s own single-`Collection`-per-request scope in this library). A decline updates
 * the caller's own `Attendee.responseStatus` in place rather than deleting the calendar item outright (the
 * real spec's behavior) - the plan for this pragmatic subset deliberately avoids introducing that extra
 * "delete on behalf of the client" pathway; the response still omits `CalendarId` for a decline, matching the
 * spec's own convention, so a client relying on that signal isn't misled into thinking a new item was created.
 *
 * `calendarEventClass`/`mailboxClass` are supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MeetingResponseCommand implements EasCommandHandler {
    public readonly command = "MeetingResponse";

    protected abstract calendarEventClass: any;
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private calendarEventRepo?: RecoverableRepoUtils<any>;
    private mailboxRepo?: RepoUtils<any>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Init
    public async init(): Promise<void> {
        this.calendarEventRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.calendarEventClass.name,
            args: [this.calendarEventClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.calendarEventRepo || !this.mailboxRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const requestEl = ctx.request ? findChild(ctx.request, "Request") : undefined;
        if (!requestEl) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const userResponse: string | undefined = childText(requestEl, "UserResponse");
        const requestId: string | undefined = childText(requestEl, "RequestId");
        if (!userResponse || !requestId || !USER_RESPONSE_STATUS[userResponse]) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const event: (CalendarEvent & { uid: string; version: number }) | undefined = await this.calendarEventRepo.findOne(
            requestId,
            { ignoreACL: true },
        );
        if (!event) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(ctx.user, event.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const mailbox: Mailbox | undefined = await this.mailboxRepo.findOne(ctx.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const callerAddresses = new Set([mailbox.primarySmtpAddress.toLowerCase(), ...mailbox.aliasAddresses.map((a: string) => a.toLowerCase())]);
        const attendeeIndex = event.attendees.findIndex((attendee) => callerAddresses.has(attendee.address.toLowerCase()));
        if (attendeeIndex === -1) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "The caller is not an attendee of this calendar event.");
        }

        const attendees = event.attendees.map((attendee, i) =>
            i === attendeeIndex ? { ...attendee, responseStatus: USER_RESPONSE_STATUS[userResponse] } : attendee,
        );
        await this.calendarEventRepo.update(
            { uid: event.uid, version: event.version, attendees } as any,
            event,
            { ignoreACL: true, user: ctx.user },
        );

        return element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
            element(WbxmlCodePage.MeetingResponse, "Result", [
                textElement(WbxmlCodePage.MeetingResponse, "RequestId", requestId),
                textElement(WbxmlCodePage.MeetingResponse, "Status", "1"),
                ...(userResponse !== USER_RESPONSE_DECLINED
                    ? [textElement(WbxmlCodePage.MeetingResponse, "CalendarId", event.uid)]
                    : []),
            ]),
        ]);
    }
}
