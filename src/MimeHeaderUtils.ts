///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import addressparser from "nodemailer/lib/addressparser";

/**
 * Raw RFC 5322 header-block helpers for the MIME a device composes (`ComposeMailCommand`).
 *
 * **Inline copy of restapi** (`util/MimeHeaderUtils.ts` in restapi's source, not exported by the `@rapidmx/restapi`
 * 0.9.0 this plugin builds against): `extractOriginatorHeaders()`, `hasAddressLikeDisplayName()`,
 * `checkOriginatorHeaders()`, `isPlainAddress()` and `safeDisplayName()` with their private helpers, kept identical - replace them with restapi's exports once the
 * dependency is bumped.
 *
 * **Plugin-side** (`checkComposedOriginators()`, `stripHeader()`): a second, byte-preserving lexer
 * (`lexHeaderFields()`) that is at least as eager as the parser reading the message later (mailparser/mailsplit):
 * the header block ends at the first empty line (`CRLF CRLF` or `LF LF`); CRLF, LF and a bare CR all end a physical
 * line; a line starting with a space or tab continues the previous field; and a field's name is everything before
 * its first colon with surrounding whitespace ignored - mailsplit trims names the same way, so a leading space on the
 * very first line or a form feed before the colon still names a `From`.
 */

// ---------------------------------------------------------------------------------------------------------------
// Inline copy of restapi's util/MimeHeaderUtils.ts
// ---------------------------------------------------------------------------------------------------------------

/**
 * Splits a raw RFC 5322 message into its header block and body, at the first blank line. Decodes/encodes via
 * the `binary` (latin1) encoding so every byte round-trips exactly.
 */
function splitRawIntoHeaderAndBody(raw: Buffer): { headerText: string; bodyText: string } {
    const text: string = raw.toString("binary");
    const match: RegExpMatchArray | null = text.match(/\r\n\r\n|\n\n/);
    if (!match || match.index === undefined) {
        return { headerText: text, bodyText: "" };
    }
    return { headerText: text.slice(0, match.index), bodyText: text.slice(match.index + match[0].length) };
}

/**
 * Strips quoted strings and (nested) comments out of a structured header value, so what is left is only the part a
 * mail client would interpret as address syntax. An unterminated quote/comment swallows the rest of the value.
 */
function stripQuotedStringsAndComments(value: string): string {
    let result: string = "";
    let inQuote: boolean = false;
    let commentDepth: number = 0;
    for (let i = 0; i < value.length; i++) {
        const ch: string = value[i];
        if (ch === "\\" && (inQuote || commentDepth > 0)) {
            i++;
            continue;
        }
        if (inQuote) {
            if (ch === '"') {
                inQuote = false;
                result += " ";
            }
            continue;
        }
        if (ch === "(") {
            commentDepth++;
            continue;
        }
        if (commentDepth > 0) {
            if (ch === ")") {
                commentDepth--;
                if (commentDepth === 0) {
                    result += " ";
                }
            }
            continue;
        }
        if (ch === '"') {
            inQuote = true;
            continue;
        }
        result += ch;
    }
    return result;
}

/**
 * Collects the text of every quoted string and comment in a structured header value (the counterpart of
 * `stripQuotedStringsAndComments()`) - where a display name or comment shows the reader text of the sender's choice.
 */
function quotedStringsAndComments(value: string): string[] {
    const parts: string[] = [];
    let current: string = "";
    let inQuote: boolean = false;
    let commentDepth: number = 0;
    for (let i = 0; i < value.length; i++) {
        const ch: string = value[i];
        if (ch === "\\" && (inQuote || commentDepth > 0)) {
            current += value[i + 1] ?? "";
            i++;
            continue;
        }
        if (inQuote) {
            if (ch === '"') {
                inQuote = false;
                parts.push(current);
                current = "";
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === "(") {
            commentDepth++;
            current += commentDepth > 1 ? ch : "";
            continue;
        }
        if (commentDepth > 0) {
            if (ch === ")") {
                commentDepth--;
                if (commentDepth === 0) {
                    parts.push(current);
                    current = "";
                    continue;
                }
            }
            current += ch;
            continue;
        }
        if (ch === '"') {
            inQuote = true;
        }
    }
    if (inQuote || commentDepth > 0) {
        parts.push(current);
    }
    return parts;
}

/** The top-level header block unfolded into logical lines, with CRLF, LF *and* a bare CR all treated as line breaks -
 * the tolerant lexing every originator-header check here shares, so a header can't hide behind a line ending some
 * other parser would honor. Continuation lines are joined with a single space. */
function lexLogicalHeaderLines(raw: Buffer): string[] {
    const { headerText } = splitRawIntoHeaderAndBody(raw);
    const logical: string[] = [];
    for (const line of headerText.split(/\r\n|\n|\r/)) {
        if (/^[ \t]/.test(line) && logical.length > 0) {
            logical[logical.length - 1] += " " + line.trim();
        } else if (line.length > 0) {
            logical.push(line);
        }
    }
    return logical;
}

/** The raw (unfolded, trimmed) values of a message's top-level `From` and `Sender` headers. */
export interface OriginatorHeaders {
    from: string[];
    sender: string[];
}

/**
 * Every top-level `From` and `Sender` header value of `raw`, found exactly the way `checkOriginatorHeaders()` finds
 * them: header names case-insensitive, whitespace before the colon allowed (the obsolete `From :` form), folded
 * values unfolded, and a bare CR treated as a line break.
 */
export function extractOriginatorHeaders(raw: Buffer): OriginatorHeaders {
    const values: OriginatorHeaders = { from: [], sender: [] };
    for (const line of lexLogicalHeaderLines(raw)) {
        const match: RegExpMatchArray | null = line.match(/^(from|sender)[ \t]*:(.*)$/i);
        if (match) {
            values[match[1].toLowerCase() as "from" | "sender"].push(match[2].trim());
        }
    }
    return values;
}

/** Decodes RFC 2047 encoded words (B and Q) to UTF-8 text - enough to see what a display name shows the reader. */
function decodeEncodedWords(text: string): string {
    return text.replace(/=\?[^?]+\?([bBqQ])\?([^?]*)\?=/g, (_match, encoding: string, data: string) => {
        if (encoding.toUpperCase() === "B") {
            return Buffer.from(data, "base64").toString("utf8");
        }
        const bytes: Buffer = Buffer.from(
            data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
            "binary",
        );
        return bytes.toString("utf8");
    });
}

/** An `@`, or a look-alike a reader would take for one (fullwidth, small and other compatibility forms). */
const AT_SIGN_LIKE = /[@＠﹫]/;

/** Whether `text` (a raw header fragment, read as latin1 bytes) shows an address-like `@` once decoded. */
function showsAtSign(text: string): boolean {
    const asUtf8: string = Buffer.from(text, "binary").toString("utf8");
    return AT_SIGN_LIKE.test(decodeEncodedWords(asUtf8)) || AT_SIGN_LIKE.test(decodeEncodedWords(text));
}

/**
 * Whether any display name, group name or comment in one `From`/`Sender` header value contains an address-like `@`
 * (RFC 2047 encoded words decoded, look-alike `@` characters included): `"ceo@example.com" <me@example.com>` shows
 * the reader an address the sender doesn't own, though its real address is fine.
 */
export function hasAddressLikeDisplayName(value: string): boolean {
    if (quotedStringsAndComments(value).some(showsAtSign)) {
        return true;
    }
    const visit = (entries: { name?: string; group?: any[] }[]): boolean =>
        entries.some((entry) => (typeof entry.name === "string" && showsAtSign(entry.name)) || (Array.isArray(entry.group) && visit(entry.group)));
    return visit(addressparser(value));
}

/** Options for `checkOriginatorHeaders()`. */
export interface OriginatorHeaderCheckOptions {
    /**
     * Also refuse a `From`/`Sender` whose display name, group name or comment contains an address
     * (`hasAddressLikeDisplayName()`). Every path that sends a user-composed message as one of a mailbox's addresses
     * should set it - the REST send path and `ScheduledSendJob` do, and so should protocol plugins (ActiveSync, MAPI).
     */
    rejectAddressLikeDisplayNames?: boolean;
}

/**
 * Refuses a raw RFC 5322 message whose originator headers name anyone other than an allowed sender. Every `From`
 * and `Sender` header in the top-level header block is checked - header names case-insensitively (including the
 * obsolete `From :` form with whitespace before the colon), folded values unfolded, and a bare CR treated as a line
 * break too, so a header can't be hidden from this scan behind a line ending another parser would honor. Returns a
 * refusal reason, or `undefined` if the message passes. Fails closed on:
 * - no `From` header, more than one `From` header, or more than one `Sender` header;
 * - a `From`/`Sender` value that yields no address at all (e.g. only an empty group);
 * - any parsed entry without an address (a malformed list, e.g. an unquoted display name containing a comma);
 * - any parsed address - group members included - that `isAllowed` rejects;
 * - any addr-spec-looking token outside quoted strings/comments that `isAllowed` rejects - covers the tolerant
 * parser recovering `<me@example.com> <other@example.com>` as one mailbox with the second as its "display name";
 * - with `options.rejectAddressLikeDisplayNames`, any display name, group name or comment containing an address.
 *
 * Quoted display names and RFC 2047 encoded words are never treated as addresses. `isAllowed` receives each address
 * exactly as parsed; normalize (e.g. lowercase) inside it.
 */
export function checkOriginatorHeaders(
    raw: Buffer,
    isAllowed: (address: string) => boolean,
    options: OriginatorHeaderCheckOptions = {},
): string | undefined {
    const values: OriginatorHeaders = extractOriginatorHeaders(raw);
    if (values.from.length === 0) {
        return "The message has no From header.";
    }
    if (values.from.length > 1) {
        return "The message has more than one From header.";
    }
    if (values.sender.length > 1) {
        return "The message has more than one Sender header.";
    }

    const refusal = (name: string): string => `The ${name} header names an address that is not one of the sending mailbox's own addresses.`;
    for (const [name, headerValues] of [
        ["From", values.from],
        ["Sender", values.sender],
    ] as [string, string[]][]) {
        for (const value of headerValues) {
            const parsed: { address?: string }[] = addressparser(value, { flatten: true });
            if (parsed.length === 0) {
                return `The ${name} header contains no address.`;
            }
            if (parsed.some((entry) => !entry.address || !isAllowed(entry.address))) {
                return refusal(name);
            }
            const tokens: string[] = stripQuotedStringsAndComments(value)
                .split(/[\s<>,;:]+/)
                .filter((token) => token.includes("@"));
            if (tokens.some((token) => !isAllowed(token))) {
                return refusal(name);
            }
            if (options.rejectAddressLikeDisplayNames && hasAddressLikeDisplayName(value)) {
                return `The ${name} header's display name or comment contains an address.`;
            }
        }
    }
    return undefined;
}

/** One plain address: no display name, angle brackets, group, comment, list, quoting, control characters or whitespace. */
const PLAIN_ADDRESS_PATTERN = /^[^\s()<>@,;:\\"[\]]+@[^\s()<>@,;:\\"[\]]+$/;

/** RFC 5321's address length limit. */
const MAX_PLAIN_ADDRESS_LENGTH = 320;

/** Whether `value` holds a control character (C0 or DEL); a tab only counts when `tabCounts`. */
function hasControlCharacter(value: string, tabCounts: boolean): boolean {
    for (let i = 0; i < value.length; i++) {
        const code: number = value.charCodeAt(i);
        if ((code < 0x20 && (tabCounts || code !== 0x09)) || code === 0x7f) {
            return true;
        }
    }
    return false;
}

/** Whether `address` is exactly one plain address (`local@domain`, nothing around it), at most 320 characters - safe to
 * hand to a composer as one recipient, e.g. a meeting attendee or organizer. */
export function isPlainAddress(address: unknown): address is string {
    return (
        typeof address === "string" &&
        address.length <= MAX_PLAIN_ADDRESS_LENGTH &&
        !hasControlCharacter(address, true) &&
        PLAIN_ADDRESS_PATTERN.test(address)
    );
}

/**
 * `name` as a display name that's safe to put in front of one of our own addresses in a `From` (or an iCalendar `CN`)
 * this server composes: trimmed, or `undefined` - so the caller omits the name - when it isn't a string, is blank,
 * contains a line break or other control character, or shows an address-like `@` (look-alikes and RFC 2047 encoded
 * words included, the same rule as `hasAddressLikeDisplayName()`). A display name like `ceo@example.com` in front of a
 * real address shows the reader an address the sender doesn't own.
 */
export function safeDisplayName(name: unknown): string | undefined {
    if (typeof name !== "string" || hasControlCharacter(name, false)) {
        return undefined;
    }
    const clean: string = name.trim();
    if (clean.length === 0 || AT_SIGN_LIKE.test(clean) || AT_SIGN_LIKE.test(decodeEncodedWords(clean))) {
        return undefined;
    }
    return clean;
}

// ---------------------------------------------------------------------------------------------------------------
// Plugin-side additions
// ---------------------------------------------------------------------------------------------------------------

/** One top-level header field of a raw message, as `lexHeaderFields()` finds it. */
interface HeaderField {
    /** Lower-cased, trimmed field name (`""` for a line without a colon). */
    name: string;
    /** Offset of the field's first byte in the `latin1` view of the message. */
    start: number;
    /** Offset just past the field's last line terminator (or continuation line). */
    end: number;
}

/** Every top-level header field of `raw`, in order, with byte offsets - see this module's doc comment. */
function lexHeaderFields(raw: Buffer): { text: string; fields: HeaderField[] } {
    const text: string = raw.toString("latin1");
    const separator: RegExpExecArray | null = /\r\n\r\n|\n\n/.exec(text);
    // The header block keeps the terminator of its last line; the empty line itself belongs to the separator.
    const headerEnd: number = separator ? separator.index + (separator[0] === "\n\n" ? 1 : 2) : text.length;
    const fields: HeaderField[] = [];
    const lineRegex = /([^\r\n]*)(\r\n|\n|\r|$)/y;
    let position = 0;
    while (position < headerEnd) {
        lineRegex.lastIndex = position;
        const match: RegExpExecArray = lineRegex.exec(text)!;
        const content: string = match[1];
        const lineEnd: number = position + match[0].length;
        const current: HeaderField | undefined = fields[fields.length - 1];
        if (/^[ \t]/.test(content) && current) {
            current.end = lineEnd;
        } else if (content.length > 0) {
            const colon: number = content.indexOf(":");
            fields.push({ name: colon === -1 ? "" : content.slice(0, colon).trim().toLowerCase(), start: position, end: lineEnd });
        }
        position = lineEnd;
    }
    return { text, fields };
}

/** An addr-spec-looking run inside display text: no whitespace, brackets, quotes, separators or second `@`. */
const DISPLAY_ADDRESS_TOKEN = /[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+/g;

/**
 * Whether every address shown in one `From`/`Sender` value's display names, group names and comments is one
 * `isAllowed` accepts - the case `hasAddressLikeDisplayName()` would refuse although it names only the sender itself
 * (`"me@example.com" <me@example.com>`, as clients do when the display name is the address, e.g. autodiscover's
 * `DisplayName`). Each text is read the way `hasAddressLikeDisplayName()` reads it (as UTF-8 and as latin1, RFC 2047
 * encoded words decoded). A look-alike `@` (fullwidth or small) is never accepted, and neither is an `@` left over once
 * every allowed address is removed (`a@b@c`, a lone encoded `@`, an address split by a quote).
 */
function displayTextShowsOnlyAllowedAddresses(value: string, isAllowed: (address: string) => boolean): boolean {
    const texts: string[] = [...quotedStringsAndComments(value)];
    const visit = (entries: { name?: string; group?: any[] }[]): void => {
        for (const entry of entries) {
            if (typeof entry.name === "string") {
                texts.push(entry.name);
            }
            if (Array.isArray(entry.group)) {
                visit(entry.group);
            }
        }
    };
    visit(addressparser(value));
    return texts.every((text) =>
        [decodeEncodedWords(Buffer.from(text, "binary").toString("utf8")), decodeEncodedWords(text)].every((view) => {
            if (/[＠﹫]/.test(view)) {
                return false;
            }
            const remainder: string = view.replace(DISPLAY_ADDRESS_TOKEN, (token) => (isAllowed(token) ? " " : "@"));
            return !remainder.includes("@");
        }),
    );
}

/**
 * The ActiveSync compose sender check: restapi's `checkOriginatorHeaders()` with `rejectAddressLikeDisplayNames`, plus
 * two plugin-side refusals restapi doesn't make. Returns a refusal reason, or `undefined` if the message passes.
 * - **Relaxed for the sender's own address**: a display name or comment that shows an address is still accepted when
 * every address it shows is one of the mailbox's own (`"me@example.com" <me@example.com>`) - see
 * `displayTextShowsOnlyAllowedAddresses()`. Any other address, or a look-alike `@`, is refused as restapi refuses it.
 * - **A `From`/`Sender` field restapi's lexer can't see** - the tolerant `lexHeaderFields()` counts more of them (e.g.
 * a leading space on the first line, or a form feed before the colon, both of which mailsplit still reads as `From`).
 * - **An empty group** (`victims:;, me@example.com`) - it contributes no address, only text of the sender's choice
 * shown beside the real address, and RFC 5322 doesn't allow groups in `From`/`Sender` at all.
 */
export function checkComposedOriginators(raw: Buffer, isAllowed: (address: string) => boolean): string | undefined {
    const refusal: string | undefined = checkOriginatorHeaders(raw, isAllowed);
    if (refusal !== undefined) {
        return refusal;
    }
    const exact: OriginatorHeaders = extractOriginatorHeaders(raw);
    for (const [name, values] of [
        ["From", exact.from],
        ["Sender", exact.sender],
    ] as [string, string[]][]) {
        if (values.some((value) => hasAddressLikeDisplayName(value) && !displayTextShowsOnlyAllowedAddresses(value, isAllowed))) {
            return `The ${name} header's display name or comment contains an address.`;
        }
    }
    const fields: HeaderField[] = lexHeaderFields(raw).fields;
    const count = (name: string): number => fields.filter((field) => field.name === name).length;
    if (count("from") !== exact.from.length || count("sender") !== exact.sender.length) {
        return "The message has a From or Sender header in a form this server doesn't accept.";
    }
    const hasEmptyGroup = (value: string): boolean =>
        (addressparser(value) as { group?: unknown[] }[]).some((entry) => Array.isArray(entry.group) && entry.group.length === 0);
    if ([...exact.from, ...exact.sender].some(hasEmptyGroup)) {
        return "The From or Sender header contains an empty group.";
    }
    return undefined;
}

/**
 * Returns a copy of `raw` with every top-level header field named `name` (case-insensitive, whitespace before the
 * colon allowed, including its folded continuation lines) removed, found with `lexHeaderFields()` - so a field
 * written `Bcc :` is removed too. Only the header block is touched; every other byte is copied verbatim.
 */
export function stripHeader(raw: Buffer, name: string): Buffer {
    const target: string = name.toLowerCase();
    const { text, fields } = lexHeaderFields(raw);
    let result: string = "";
    let copiedUpTo: number = 0;
    for (const field of fields) {
        if (field.name === target) {
            result += text.slice(copiedUpTo, field.start);
            copiedUpTo = field.end;
        }
    }
    return Buffer.from(result + text.slice(copiedUpTo), "latin1");
}
