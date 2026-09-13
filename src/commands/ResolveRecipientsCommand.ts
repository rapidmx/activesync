///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators, StringUtils } from "@rapidrest/core";
import { ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { Contact } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { element, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Config, Init } = ObjectDecorators;

/** A simple, deliberately permissive email-address shape check - just enough to distinguish "the client sent
 * an address it already knows how to reach" from "the client sent a partial name/string that needs GAL
 * lookup", not full RFC 5322 validation. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** [MS-ASCMD] `ResolveRecipients` per-`To` `Status` codes this pragmatic subset actually distinguishes: `1`
 * success (at least one match, or the input already looked like a resolvable address), `4` no match found -
 * an approximation, not a byte-exact enumeration of every real status code MS-ASCMD's `ResolveRecipients` page
 * defines, matching `ProvisionCommand`'s own identical precedent for the same reasoning. */
const STATUS_SUCCESS = "1";
const STATUS_NOT_FOUND = "4";

/**
 * Handles EAS `ResolveRecipients`: resolves each `<To>` value (a display name, partial name, or address) the
 * client is unsure how to reach against the mailbox's own `Contact` (GAL) store - the same substring-match
 * approach `SearchCommand` uses for its own `Store Name="GAL"` lookups, duplicated rather than shared (small
 * enough, and specific enough to each command's own surrounding logic, that extracting a shared utility for two
 * call sites isn't worth a new cross-command dependency). Both use `RepoUtils`' `regex(...)` operator (not
 * `like(...)`, which compiles a glob pattern under `@rapidrest/service-core` ^2.0 - anchored, and with no escape
 * for a literal `*`/`?`): `StringUtils.escapeRegExp(value)` gives a genuine, unanchored literal-substring match
 * with no residual wildcard ambiguity, matching the same fix already applied to the `mapi` plugin's own
 * identical GAL-search gap.
 *
 * **Pragmatic subset**: no free-busy `Availability`, no S/MIME `Certificates`/`Options` handling at all - this
 * command's real-world use is overwhelmingly enterprise S/MIME certificate lookup, which this library doesn't
 * implement elsewhere either (`ComposeMailCommand` sends plain MIME, never signed/encrypted). A `<To>` value
 * that already looks like an email address (`LOOKS_LIKE_EMAIL`) is echoed straight back as its own single
 * exact match rather than searched for, matching a real client's own common case of resolving an address it
 * already typed correctly.
 *
 * `contactClass` is supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ResolveRecipientsCommand implements EasCommandHandler {
    public readonly command = "ResolveRecipients";

    protected abstract contactClass: any;

    @Config("mail:eas:resolve_recipients_max_matches", 10)
    private maxMatches: number = 10;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private contactRepo?: RepoUtils<any>;

    @Init
    public async init(): Promise<void> {
        this.contactRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.contactClass.name,
            args: [this.contactClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        const toEls = ctx.request ? findChildren(ctx.request, "To") : [];
        const responses: WbxmlElement[] = [];
        for (const toEl of toEls) {
            const value = toEl.text ?? "";
            responses.push(await this.resolveOne(ctx, value));
        }
        return element(WbxmlCodePage.ResolveRecipients, "ResolveRecipients", [
            textElement(WbxmlCodePage.ResolveRecipients, "Status", "1"),
            ...responses,
        ]);
    }

    private async resolveOne(ctx: EasCommandContext, value: string): Promise<WbxmlElement> {
        if (LOOKS_LIKE_EMAIL.test(value)) {
            return this.responseElement(value, STATUS_SUCCESS, [this.recipientElement(value, undefined)]);
        }

        const pattern = StringUtils.escapeRegExp(value);
        const findOptions: any = { ignoreACL: true, limit: this.maxMatches };
        const perField = await Promise.all(
            ["displayName", "givenName", "surname"].map((field) =>
                this.contactRepo!.find({ mailboxUid: ctx.mailboxUid, [field]: `regex(${pattern})` } as any, findOptions),
            ),
        );
        const byUid = new Map<string, Contact & { uid: string }>();
        for (const contact of perField.flat()) {
            byUid.set(contact.uid, contact);
        }
        const matches = Array.from(byUid.values())
            .filter((contact) => contact.emails[0])
            .slice(0, this.maxMatches);

        if (matches.length === 0) {
            return this.responseElement(value, STATUS_NOT_FOUND, []);
        }

        return this.responseElement(
            value,
            STATUS_SUCCESS,
            matches.map((contact) => this.recipientElement(contact.emails[0].address, contact.displayName)),
        );
    }

    private recipientElement(address: string, displayName: string | undefined): WbxmlElement {
        return element(WbxmlCodePage.ResolveRecipients, "Recipient", [
            textElement(WbxmlCodePage.ResolveRecipients, "Type", "1"),
            ...(displayName ? [textElement(WbxmlCodePage.ResolveRecipients, "DisplayName", displayName)] : []),
            textElement(WbxmlCodePage.ResolveRecipients, "EmailAddress", address),
        ]);
    }

    private responseElement(to: string, status: string, recipients: WbxmlElement[]): WbxmlElement {
        return element(WbxmlCodePage.ResolveRecipients, "Response", [
            textElement(WbxmlCodePage.ResolveRecipients, "To", to),
            textElement(WbxmlCodePage.ResolveRecipients, "Status", status),
            ...(recipients.length > 0
                ? [
                      textElement(WbxmlCodePage.ResolveRecipients, "RecipientCount", String(recipients.length)),
                      ...recipients,
                  ]
                : []),
        ]);
    }
}
