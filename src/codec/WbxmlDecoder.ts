///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { tagNameForCode } from "./WbxmlCodePages.js";
import type { WbxmlElement } from "./WbxmlElement.js";

// See WbxmlEncoder.ts for citations on these WBXML global tokens and the tag-byte flag bits.
const SWITCH_PAGE = 0x00;
const END = 0x01;
const STR_I = 0x03;
const OPAQUE = 0xc3;
const CONTENT_FLAG = 0x40;
const ATTR_FLAG = 0x80;
const TAG_CODE_MASK = 0x3f;

/** Default cap on the total number of elements decoded from one document. An element costs as little as one
 * wire byte (an empty tag token), so without this a small body could allocate millions of element objects. */
export const WBXML_DEFAULT_MAX_ELEMENTS = 50_000;

/** Default cap on the number of direct children of any single element. */
export const WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT = 10_000;

/** Default cap on element nesting depth (the root is depth 1). Nesting costs ~2 wire bytes per level and drives
 * the decoder's recursion, so it needs its own bound; real EAS documents stay well under 20 levels. */
export const WBXML_DEFAULT_MAX_DEPTH = 64;

/** Limits applied by `WbxmlDecoder`. Every value must be a positive integer; omitted values use the defaults. */
export interface WbxmlDecoderOptions {
    /** Maximum total elements in the document. Default `WBXML_DEFAULT_MAX_ELEMENTS`. */
    maxElements?: number;
    /** Maximum direct children of any one element. Default `WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT`. */
    maxChildrenPerElement?: number;
    /** Maximum nesting depth (root = 1). Default `WBXML_DEFAULT_MAX_DEPTH`. */
    maxDepth?: number;
}

/** Thrown by `WbxmlDecoder.decode()` for malformed or unsupported input (truncated buffer, unterminated string,
 * attribute-flagged tag, a length field running past the end of the buffer, ...). */
export class WbxmlDecodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WbxmlDecodeError";
    }
}

/** Thrown by `WbxmlDecoder.decode()` when a document exceeds a configured resource limit (element count,
 * children per element, or nesting depth). A subclass of `WbxmlDecodeError`, so callers that treat every
 * decoder failure as a bad request can catch just the base class. */
export class WbxmlLimitError extends WbxmlDecodeError {
    constructor(message: string) {
        super(message);
        this.name = "WbxmlLimitError";
    }
}

function positiveIntOption(name: string, value: number | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`WbxmlDecoder: option ${name} must be a positive integer, got ${value}`);
    }
    return value;
}

/**
 * Decodes a WBXML byte stream (an EAS request/response body) back into a `WbxmlElement` tree — the exact
 * inverse of `WbxmlEncoder`. Reads the fixed EAS document header, skips its (always-empty, in real
 * ActiveSync traffic) string table, then parses the single root element.
 *
 * Input is untrusted, so decoding is bounded: total elements, children per element and nesting depth are
 * capped (see `WbxmlDecoderOptions`), throwing `WbxmlLimitError` when exceeded; all other malformed input throws
 * `WbxmlDecodeError`. Text and opaque payloads are bounded by the input buffer itself.
 *
 * The `publicid` header field is read via the same generic `mb_u_int32` reader used everywhere else, which is
 * only a partial implementation of the full WBXML spec for that field (a raw leading `0x00` byte would
 * signal "public identifier is a string-table reference" under the full spec, a form real ActiveSync traffic
 * never uses) — safe here since every real EAS document sends the literal well-known value `1` ("unknown or
 * missing"), which decodes identically either way.
 *
 * @author Jean-Philippe Steinmetz
 */
export class WbxmlDecoder {
    private readonly maxElements: number;
    private readonly maxChildrenPerElement: number;
    private readonly maxDepth: number;
    private buf: Buffer = Buffer.alloc(0);
    private pos = 0;
    private currentPage = 0;
    private depth = 0;
    private elementCount = 0;

    constructor(options: WbxmlDecoderOptions = {}) {
        this.maxElements = positiveIntOption("maxElements", options.maxElements, WBXML_DEFAULT_MAX_ELEMENTS);
        this.maxChildrenPerElement = positiveIntOption(
            "maxChildrenPerElement",
            options.maxChildrenPerElement,
            WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT,
        );
        this.maxDepth = positiveIntOption("maxDepth", options.maxDepth, WBXML_DEFAULT_MAX_DEPTH);
    }

    public decode(data: Buffer): WbxmlElement {
        this.buf = data;
        this.pos = 0;
        this.currentPage = 0;
        this.depth = 0;
        this.elementCount = 0;

        try {
            this.readByte(); // version - not validated; every ActiveSync client/server variant this library
            // targets sends 0x03 (WBXML 1.3), but nothing here depends on that specific value.
            this.readMbUint(); // publicid
            this.readMbUint(); // charset
            const stringTableLength: number = this.readMbUint();
            this.requireAvailable(stringTableLength, "string table");
            this.pos += stringTableLength; // skip the (always empty, for ActiveSync) string table

            // A leading SWITCH_PAGE before the root tag is legal (and common - e.g. a `Provision` document's
            // root element lives on code page 14, not the page-0 `AirSync` default) and is not itself part of
            // any element's content, so it's consumed here rather than inside `readTagElement()`.
            while (this.pos < this.buf.length && this.buf[this.pos] === SWITCH_PAGE) {
                this.pos++;
                this.currentPage = this.readByte();
            }

            return this.readTagElement();
        } finally {
            this.buf = Buffer.alloc(0); // don't retain the caller's (possibly large) request body
        }
    }

    private readByte(): number {
        if (this.pos >= this.buf.length) {
            throw new WbxmlDecodeError("WbxmlDecoder: unexpected end of buffer");
        }
        return this.buf[this.pos++];
    }

    /** Throws unless at least `length` bytes remain from the current position. */
    private requireAvailable(length: number, what: string): void {
        if (length > this.buf.length - this.pos) {
            throw new WbxmlDecodeError(
                `WbxmlDecoder: ${what} length ${length} runs past the end of the buffer (${this.buf.length - this.pos} bytes remain)`,
            );
        }
    }

    /** Decodes a WBXML `mb_u_int32`: base-128 digits, most significant group first, every byte but the last
     * carrying the 0x80 continuation bit. Mirrors `WbxmlEncoder.writeMbUint()`. */
    private readMbUint(): number {
        let value = 0;
        for (;;) {
            const byte = this.readByte();
            value = value * 128 + (byte & 0x7f);
            if ((byte & 0x80) === 0) {
                return value;
            }
        }
    }

    private readCString(): string {
        const start = this.pos;
        const end = this.buf.indexOf(0x00, start);
        if (end < 0) {
            throw new WbxmlDecodeError("WbxmlDecoder: unterminated inline string (STR_I)");
        }
        this.pos = end + 1; // skip the null terminator
        return this.buf.toString("utf-8", start, end);
    }

    private readTagElement(): WbxmlElement {
        if (++this.elementCount > this.maxElements) {
            throw new WbxmlLimitError(`WbxmlDecoder: exceeded maximum element count of ${this.maxElements}`);
        }
        if (++this.depth > this.maxDepth) {
            throw new WbxmlLimitError(`WbxmlDecoder: exceeded maximum nesting depth of ${this.maxDepth}`);
        }
        try {
            const byte = this.readByte();
            if ((byte & ATTR_FLAG) !== 0) {
                throw new WbxmlDecodeError(
                    "WbxmlDecoder: attributes are not supported (ActiveSync's WBXML profile never uses them)",
                );
            }
            const page = this.currentPage;
            const tag = tagNameForCode(page, byte & TAG_CODE_MASK);
            if ((byte & CONTENT_FLAG) === 0) {
                return { page, tag, children: [] };
            }
            const { children, text, opaque } = this.readContentUntilEnd();
            return { page, tag, children, text, opaque };
        } finally {
            this.depth--;
        }
    }

    /** Reads a mixed sequence of child tag elements / an inline string / opaque binary content, up to (and
     * consuming) the terminating `END` token — the body of one "has content" element. Also handles a
     * `SWITCH_PAGE` appearing between sibling children, which applies to every subsequent sibling until
     * either the next switch or the end of this content block (switching page is a standing instruction, not
     * scoped to a single following tag). */
    private readContentUntilEnd(): { children: WbxmlElement[]; text?: string; opaque?: Buffer } {
        const children: WbxmlElement[] = [];
        let text: string | undefined;
        let opaque: Buffer | undefined;

        for (;;) {
            if (this.pos >= this.buf.length) {
                throw new WbxmlDecodeError("WbxmlDecoder: unexpected end of buffer while reading element content");
            }
            const token = this.buf[this.pos];
            if (token === END) {
                this.pos++;
                break;
            } else if (token === SWITCH_PAGE) {
                this.pos++;
                this.currentPage = this.readByte();
            } else if (token === STR_I) {
                this.pos++;
                // Concatenates rather than overwrites: a defensive accommodation for an encoder that splits
                // one logical text value across multiple consecutive STR_I tokens (legal per WBXML, though
                // not something this library's own encoder ever does) rather than data loss on replay.
                text = (text ?? "") + this.readCString();
            } else if (token === OPAQUE) {
                this.pos++;
                const length = this.readMbUint();
                this.requireAvailable(length, "OPAQUE");
                opaque = Buffer.from(this.buf.subarray(this.pos, this.pos + length));
                this.pos += length;
            } else {
                if (children.length >= this.maxChildrenPerElement) {
                    throw new WbxmlLimitError(
                        `WbxmlDecoder: exceeded maximum of ${this.maxChildrenPerElement} children per element`,
                    );
                }
                children.push(this.readTagElement());
            }
        }

        return { children, text, opaque };
    }
}
