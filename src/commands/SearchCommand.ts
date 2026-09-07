///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { Contact } from "@rapidmx/restapi";
const { Config, Init } = ObjectDecorators;

/** Escapes regex metacharacters so a client-supplied search string is matched literally by `RepoUtils`' own
 * `like(pattern)` query operator (which compiles to a case-insensitive `$regex`) - without this, a query
 * containing e.g. `.` or `(` would be interpreted as regex syntax rather than the literal characters typed. */
function escapeForLikeQuery(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * Handles EAS `Search` for the `GAL` store only - this library's `Contact` records are also the source of
 * truth for GAL lookups against a mailbox's own address book (see the architecture note on `Contact` itself);
 * searching a mailbox's item contents or a document library (the other two `Search` store types the real spec
 * defines) is out of scope for this pragmatic subset.
 *
 * Per the plan's own scope: a simple case-insensitive substring match via `RepoUtils.find()` directly, not the
 * heavier `SearchProvider` full-text index - GAL lookups are small-scale exact/prefix matching against a
 * personal address book, not relevance-ranked full text over large content. Only `displayName`/`givenName`/
 * `surname`/`company` are matched - `Contact.emails`/`phones` are embedded arrays of objects, which a plain
 * per-field regex query can't reach into on either backend (confirmed: MongoDB's `$regex` against an
 * array-of-objects field matches nothing useful, and this library's own query-injection guard rejects
 * dot-notation field paths like `"emails.address"` outright) - a documented gap, not an oversight.
 *
 * `contactClass` is supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SearchCommand implements EasCommandHandler {
    public readonly command = "Search";

    protected abstract contactClass: any;

    /** Wraps an already regex-escaped substring for this backend's `like()` operator. A second real
     * cross-backend gap (confirmed by reading both implementations, not assumed): Mongo's `like()` compiles to
     * an unanchored `$regex` (a substring match with no wrapping needed), but the SQL backend's compiles to
     * TypeORM's `ILike()` (a plain SQL `LIKE`, which is an *exact* case-insensitive match unless the pattern
     * itself carries `%` wildcards) - so the same escaped pattern needs `%pattern%` on SQL but must NOT get
     * literal `%` characters on Mongo, where they'd be matched as themselves in the regex and never found.
     * Supplied by the Mongo/SQL concrete subclasses. */
    protected abstract likePattern(escaped: string): string;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private contactRepo?: RepoUtils<any>;

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
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.contactRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const storeEl = ctx.request ? findChild(ctx.request, "Store") : undefined;
        const name: string | undefined = storeEl ? childText(storeEl, "Name") : undefined;
        const query: string | undefined = storeEl ? childText(storeEl, "Query") : undefined;
        if (!storeEl || name !== "GAL" || !query) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Search requires a Store with Name 'GAL' and a Query.");
        }

        const optionsEl = findChild(storeEl, "Options");
        const { start, end } = parseRange(
            optionsEl ? childText(optionsEl, "Range") : undefined,
            this.defaultRangeEnd,
            this.maxRangeEnd,
        );

        // `$or` is a Mongo-only feature of this framework's query builder - `buildSearchQuerySQL` (confirmed by
        // reading its source) has no handling for it at all, so passing one on the SQL backend silently builds
        // a broken TypeORM `where` clause (a literal `$or` property, not a real OR) and 500s. Querying each
        // field separately and merging in memory - the same workaround `EasSyncKeyUtils.computeChanges()`
        // already uses for its own two-backend query gap - works identically on both backends instead.
        const pattern = this.likePattern(escapeForLikeQuery(query));
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

        const page: Contact[] = matches.slice(start, end + 1);
        // Both ends forced to 0 when there are no matches at all - `start` alone (from a client-requested
        // Range like "5-10") would otherwise survive unclamped, producing a malformed "5-0" (start > end) once
        // `end` collapses to 0. A non-empty result always has a real, in-range `start` already (see
        // `parseRange`), so this only ever changes behavior for the zero-match case.
        const rangeStart = matches.length === 0 ? 0 : start;
        const rangeEnd = matches.length === 0 ? 0 : Math.min(end, matches.length - 1);

        return element(WbxmlCodePage.Search, "Search", [
            textElement(WbxmlCodePage.Search, "Status", "1"),
            element(WbxmlCodePage.Search, "Response", [
                element(WbxmlCodePage.Search, "Store", [
                    textElement(WbxmlCodePage.Search, "Status", "1"),
                    ...page.map((contact) => this.contactToResult(contact)),
                    textElement(WbxmlCodePage.Search, "Range", `${rangeStart}-${rangeEnd}`),
                    textElement(WbxmlCodePage.Search, "Total", String(matches.length)),
                ]),
            ]),
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
}
