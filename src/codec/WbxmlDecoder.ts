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

/**
 * Decodes a WBXML byte stream (an EAS request/response body) back into a `WbxmlElement` tree — the exact
 * inverse of `WbxmlEncoder`. Reads the fixed EAS document header, skips its (always-empty, in real
 * ActiveSync traffic) string table, then parses the single root element.
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
    private buf: Buffer = Buffer.alloc(0);
    private pos = 0;
    private currentPage = 0;

    public decode(data: Buffer): WbxmlElement {
        this.buf = data;
        this.pos = 0;
        this.currentPage = 0;

        this.readByte(); // version - not validated; every ActiveSync client/server variant this library
        // targets sends 0x03 (WBXML 1.3), but nothing here depends on that specific value.
        this.readMbUint(); // publicid
        this.readMbUint(); // charset
        const stringTableLength: number = this.readMbUint();
        this.pos += stringTableLength; // skip the (always empty, for ActiveSync) string table

        // A leading SWITCH_PAGE before the root tag is legal (and common - e.g. a `Provision` document's
        // root element lives on code page 14, not the page-0 `AirSync` default) and is not itself part of
        // any element's content, so it's consumed here rather than inside `readTagElement()`.
        while (this.pos < this.buf.length && this.buf[this.pos] === SWITCH_PAGE) {
            this.pos++;
            this.currentPage = this.readByte();
        }

        return this.readTagElement();
    }

    private readByte(): number {
        if (this.pos >= this.buf.length) {
            throw new Error("WbxmlDecoder: unexpected end of buffer");
        }
        return this.buf[this.pos++];
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
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x00) {
            this.pos++;
        }
        if (this.pos >= this.buf.length) {
            throw new Error("WbxmlDecoder: unterminated inline string (STR_I)");
        }
        const value = this.buf.toString("utf-8", start, this.pos);
        this.pos++; // skip the null terminator
        return value;
    }

    private readTagElement(): WbxmlElement {
        const byte = this.readByte();
        if ((byte & ATTR_FLAG) !== 0) {
            throw new Error("WbxmlDecoder: attributes are not supported (ActiveSync's WBXML profile never uses them)");
        }
        const page = this.currentPage;
        const tag = tagNameForCode(page, byte & TAG_CODE_MASK);
        if ((byte & CONTENT_FLAG) === 0) {
            return { page, tag, children: [] };
        }
        const { children, text, opaque } = this.readContentUntilEnd();
        return { page, tag, children, text, opaque };
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
                throw new Error("WbxmlDecoder: unexpected end of buffer while reading element content");
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
                opaque = Buffer.from(this.buf.subarray(this.pos, this.pos + length));
                this.pos += length;
            } else {
                children.push(this.readTagElement());
            }
        }

        return { children, text, opaque };
    }
}
