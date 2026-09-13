///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { EmailSyncAdapter } from "../adapters/EmailSyncAdapter.js";
import type { Contact, Message } from "@rapidmx/restapi";
import type { SearchProvider } from "@rapidmx/restapi/search";
const { Config, Init, Inject } = ObjectDecorators;

/** Wraps a client-supplied search string as a glob pattern (`*` = any sequence, `?` = any single character) for
 * `RepoUtils`' `like()` query operator, so a partial name matches as a case-insensitive substring. Since
 * `@rapidrest/service-core` 2.x, `like()` compiles glob syntax identically on both Mongo (`globToRegExpSource` -
 * an anchored, fully-escaped `$regex`) and SQL (`globToLike` - a `LIKE` pattern), rather than the old two-backend
 * split this file used to document (Mongo unanchored-regex vs. SQL exact-unless-`%`-wrapped) - confirmed by
 * reading `ModelUtils.ts` directly, not assumed from the version bump alone. Neither translation offers an
 * escape mechanism for a literal `*`/`?` a user happens to type (`globToLike`'s own doc comment: "a client
 * wanting to match a literal % or _ cannot fully escape it, a narrow, documented limitation"), so this wraps
 * only - it does not attempt to neutralize those two characters, matching the framework's own accepted stance. */
function globPattern(value: string): string {
    return `*${value}*`;
}

/** Parses a `Range` value (`"m-n"`, a zero-based inclusive index pair) into `{ start, end }`, falling back to
 * `defaultEnd` for a missing/malformed value - never trusting the client to request more than `maxEnd` rows. */
function parseRange(raw: string | undefined, defaultEnd: number, maxEnd: number): { start: number; end: number } {
    const match = raw?.match(/^(\d+)-(\d+)$/);
    if (!match) {
        return { start: 0, end: Math.min(defaultEnd, maxEnd) };
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), maxEnd);
    return start <= end ? { start, end } : { start: 0, end: Math.min(defaultEnd, maxEnd) };
}

/** Clamps a matched-results array against a requested `[start, end]` Range, reporting both the sliced page and
 * the actual Range/Total to echo back - shared by the `GAL` and `Mailbox` branches below, which otherwise
 * differ only in how they produce `matches` and render one entry. Both ends are forced to `0` when there are no
 * matches at all - `start` alone (from a client-requested Range like `"5-10"`) would otherwise survive
 * unclamped, producing a malformed `"5-0"` (start > end) once `end` collapses to `0`. */
function paginate<T>(matches: T[], start: number, end: number): { page: T[]; rangeStart: number; rangeEnd: number } {
    return {
        page: matches.slice(start, end + 1),
        rangeStart: matches.length === 0 ? 0 : start,
        rangeEnd: matches.length === 0 ? 0 : Math.min(end, matches.length - 1),
    };
}

/**
 * Handles EAS `Search` for the `GAL` and `Mailbox` stores - `DocumentLibrary` (the real spec's third store type)
 * remains out of scope, matching `ItemOperationsCommand`'s identical scope decision; this library has no
 * document-library model.
 *
 * **`GAL`**: this library's `Contact` records are also the source of truth for GAL lookups against a mailbox's
 * own address book (see the architecture note on `Contact` itself). A simple case-insensitive substring match
 * via `RepoUtils.find()` directly, not the heavier `SearchProvider` full-text index - GAL lookups are
 * small-scale exact/prefix matching against a personal address book, not relevance-ranked full text over large
 * content. Only `displayName`/`givenName`/`surname`/`company` are matched - `Contact.emails`/`phones` are
 * embedded arrays of objects, which a plain per-field regex query can't reach into on either backend (confirmed:
 * MongoDB's `$regex` against an array-of-objects field matches nothing useful, and this library's own
 * query-injection guard rejects dot-notation field paths like `"emails.address"` outright) - a documented gap,
 * not an oversight.
 *
 * **`Mailbox`**: real full-text search over the caller's own `Email` messages, backed by `restapi`'s
 * `SearchProvider` (its own full-text index, kept eventually-consistent with the primary datastore via
 * `SearchIndexJob` - a just-sent/just-received message may briefly not be findable yet). **Pragmatic subset**:
 * only `Class` `Email` is supported (a `Query` naming any other class is rejected, matching the `GAL`-only
 * precedent this file already established for search generally); only the common real-world `Query` shape -
 * `Class`/`CollectionId`/`FreeText`, optionally grouped under one `And` - is parsed, not the full recursive
 * `And`/`Or`/`EqualTo`/`GreaterThan`/`LessThan` boolean-tree grammar MS-ASCMD's schema allows for, so a
 * multi-level nested query silently only sees the first `And` group's own direct children. Each match is
 * re-verified for `READ` on its own current `folderUid` before being included - `SearchProvider`'s index is
 * scoped by `mailboxUid` alone, not per-folder ACL, so this is the one place that check still has to happen
 * per-result rather than once up front. `SearchResultPage` carries no total count (the underlying providers
 * don't compute one cheaply over a relevance-ranked query), so `Total` here means "how many matches this
 * request's own capped fetch actually returned" - a client requesting a `Range` past that cap sees fewer
 * results than may really exist, a documented approximation rather than exact server-side paging.
 *
 * `contactClass`/`messageClass`/`emailAdapterClass` are supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SearchCommand implements EasCommandHandler {
    public readonly command = "Search";

    protected abstract contactClass: any;
    protected abstract messageClass: any;
    protected abstract emailAdapterClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private contactRepo?: RepoUtils<any>;
    private messageRepo?: RepoUtils<any>;
    private emailAdapter?: EmailSyncAdapter;

    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Config("mail:eas:search_default_range", 9)
    private defaultRangeEnd: number = 9;

    @Config("mail:eas:search_max_range", 99)
    private maxRangeEnd: number = 99;

    @Init
    public async init(): Promise<void> {
        this.contactRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.contactClass.name,
            args: [this.contactClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.emailAdapter = await this._objectFactory!.newInstance(this.emailAdapterClass);
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.contactRepo || !this.messageRepo || !this.searchProvider || !this.emailAdapter) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const storeEl = ctx.request ? findChild(ctx.request, "Store") : undefined;
        const name: string | undefined = storeEl ? childText(storeEl, "Name") : undefined;
        if (!storeEl || (name !== "GAL" && name !== "Mailbox")) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Search requires a Store with Name 'GAL' or 'Mailbox'.");
        }

        const optionsEl = findChild(storeEl, "Options");
        const { start, end } = parseRange(
            optionsEl ? childText(optionsEl, "Range") : undefined,
            this.defaultRangeEnd,
            this.maxRangeEnd,
        );

        const storeResponse = name === "GAL" ? await this.handleGal(ctx, storeEl, start, end) : await this.handleMailbox(ctx, storeEl, start, end);

        return element(WbxmlCodePage.Search, "Search", [
            textElement(WbxmlCodePage.Search, "Status", "1"),
            element(WbxmlCodePage.Search, "Response", [storeResponse]),
        ]);
    }

    private async handleGal(ctx: EasCommandContext, storeEl: WbxmlElement, start: number, end: number): Promise<WbxmlElement> {
        const query = childText(storeEl, "Query");
        if (!query) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Search requires a Store with Name 'GAL' and a Query.");
        }

        // `$or` is a Mongo-only feature of this framework's query builder - `buildSearchQuerySQL` (confirmed by
        // reading its source) has no handling for it at all, so passing one on the SQL backend silently builds
        // a broken TypeORM `where` clause (a literal `$or` property, not a real OR) and 500s. Querying each
        // field separately and merging in memory - the same workaround `EasSyncKeyUtils.computeChanges()`
        // already uses for its own two-backend query gap - works identically on both backends instead.
        const pattern = globPattern(query);
        const findOptions: any = { ignoreACL: true, limit: this.maxRangeEnd + 1 };
        const perField = await Promise.all(
            ["displayName", "givenName", "surname", "company"].map((field) =>
                this.contactRepo!.find({ mailboxUid: ctx.mailboxUid, [field]: `like(${pattern})`, limit: this.maxRangeEnd + 1 } as any, findOptions),
            ),
        );
        const byUid = new Map<string, Contact & { uid: string }>();
        for (const contact of perField.flat()) {
            byUid.set((contact).uid, contact);
        }
        const matches: Contact[] = Array.from(byUid.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
        const { page, rangeStart, rangeEnd } = paginate(matches, start, end);

        return element(WbxmlCodePage.Search, "Store", [
            textElement(WbxmlCodePage.Search, "Status", "1"),
            ...page.map((contact) => this.contactToResult(contact)),
            textElement(WbxmlCodePage.Search, "Range", `${rangeStart}-${rangeEnd}`),
            textElement(WbxmlCodePage.Search, "Total", String(matches.length)),
        ]);
    }

    private async handleMailbox(ctx: EasCommandContext, storeEl: WbxmlElement, start: number, end: number): Promise<WbxmlElement> {
        const queryEl = findChild(storeEl, "Query");
        if (!queryEl) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Search requires a Store with Name 'Mailbox' and a Query.");
        }
        // The common real-world shape groups Class/CollectionId/FreeText under one And - see this class's own
        // doc comment for why a deeper And/Or tree isn't parsed. Falling back to Query's own direct children
        // also accepts a client that omits the And wrapper entirely, which the schema itself permits.
        const container = findChild(queryEl, "And") ?? queryEl;
        const className = childText(container, "Class");
        const folderUid = childText(container, "CollectionId");
        const freeText = childText(container, "FreeText");
        if (className !== "Email" || !freeText) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                "Search on the 'Mailbox' store requires a Query with Class 'Email' and a FreeText term.",
            );
        }

        const resultPage = await this.searchProvider!.search({
            mailboxUid: ctx.mailboxUid,
            text: freeText,
            entityTypes: ["message"],
            folderUid,
            limit: this.maxRangeEnd + 1,
        });

        const matches: Message[] = [];
        for (const result of resultPage.results) {
            const message: Message | undefined = await this.messageRepo!.findOne(result.entityUid, { ignoreACL: true });
            if (!message) {
                continue;
            }
            if (!(await this.aclUtils!.hasPermission(ctx.user, message.folderUid, ACLAction.READ))) {
                continue;
            }
            matches.push(message);
        }
        const { page, rangeStart, rangeEnd } = paginate(matches, start, end);
        const results = await Promise.all(page.map((message) => this.messageToResult(message)));

        return element(WbxmlCodePage.Search, "Store", [
            textElement(WbxmlCodePage.Search, "Status", "1"),
            ...results,
            textElement(WbxmlCodePage.Search, "Range", `${rangeStart}-${rangeEnd}`),
            textElement(WbxmlCodePage.Search, "Total", String(matches.length)),
        ]);
    }

    private contactToResult(contact: Contact): WbxmlElement {
        const properties: WbxmlElement[] = [
            textElement(WbxmlCodePage.Gal, "DisplayName", contact.displayName),
            ...(contact.givenName ? [textElement(WbxmlCodePage.Gal, "FirstName", contact.givenName)] : []),
            ...(contact.surname ? [textElement(WbxmlCodePage.Gal, "LastName", contact.surname)] : []),
            ...(contact.company ? [textElement(WbxmlCodePage.Gal, "Company", contact.company)] : []),
            ...(contact.jobTitle ? [textElement(WbxmlCodePage.Gal, "Title", contact.jobTitle)] : []),
            ...(contact.emails[0] ? [textElement(WbxmlCodePage.Gal, "EmailAddress", contact.emails[0].address)] : []),
            ...(contact.phones[0] ? [textElement(WbxmlCodePage.Gal, "Phone", contact.phones[0].phoneNumber)] : []),
        ];
        return element(WbxmlCodePage.Search, "Result", [element(WbxmlCodePage.Search, "Properties", properties)]);
    }

    /** Reuses `EmailSyncAdapter.toApplicationData()`'s own field mapping (Subject/From/To/Cc/Bcc/DateReceived/
     * Importance/Read/Flag/Body/ConversationId) for a Mailbox-store search hit's `Properties` - the same
     * per-field shape `Sync` already renders for this message, rather than a second, parallel mapping that
     * could drift out of sync with it. */
    private async messageToResult(message: Message): Promise<WbxmlElement> {
        const applicationData = await this.emailAdapter!.toApplicationData(message);
        return element(WbxmlCodePage.Search, "Result", [
            textElement(WbxmlCodePage.AirSync, "Class", "Email"),
            textElement(WbxmlCodePage.AirSync, "CollectionId", message.folderUid),
            textElement(WbxmlCodePage.AirSync, "ServerId", (message as any).uid),
            element(WbxmlCodePage.Search, "Properties", applicationData.children),
        ]);
    }
}
