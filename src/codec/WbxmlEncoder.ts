///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { codeForTagName } from "./WbxmlCodePages.js";
import type { WbxmlElement } from "./WbxmlElement.js";

// WBXML global tokens (MS-ASWBXML §1.6 "Standards Assignments" / [WBXML1.2]) that appear outside a code
// page's own tag-token space, and so are shared across every page.
const SWITCH_PAGE = 0x00;
const END = 0x01;
const STR_I = 0x03;
const OPAQUE = 0xc3;

/** U+0000, the character whose UTF-8 encoding is the `STR_I` terminator byte. */
const NUL = String.fromCharCode(0);

/** Bit flags folded into a tag token byte alongside its 6-bit code (MS-ASWBXML §2.1.2.2 "Tag Format"). Only
 * `CONTENT_FLAG` is ever set by this encoder - ActiveSync's WBXML profile never uses attributes. */
const CONTENT_FLAG = 0x40;

/** Token bytes are buffered in a small scratch array and flushed into a `Buffer` chunk once it reaches this
 * many bytes (or before a text/opaque payload is appended as its own chunk). */
export const WBXML_ENCODER_SCRATCH_SIZE = 4096;

/** Options for `WbxmlEncoder`. */
export interface WbxmlEncoderOptions {
    /** Maximum size in bytes of an encoded document (header included). Must be a positive integer or
     * `Infinity`; default `Infinity` (no limit). Exceeding it throws `WbxmlSizeLimitError`. */
    maxBytes?: number;
}

/** Thrown by `WbxmlEncoder.encode()` when the encoded document would exceed the configured `maxBytes`. */
export class WbxmlSizeLimitError extends Error {
    public readonly maxBytes: number;

    constructor(maxBytes: number) {
        super(`WbxmlEncoder: encoded document exceeds the maximum size of ${maxBytes} bytes`);
        this.name = "WbxmlSizeLimitError";
        this.maxBytes = maxBytes;
    }
}

/** Returns the number of bytes an `mb_u_int32` encoding of `value` occupies. */
function mbUintSize(value: number): number {
    let size = 1;
    while (value >= 128) {
        value = Math.floor(value / 128);
        size++;
    }
    return size;
}

/** Returns the exact wire size of an `OPAQUE` token carrying `payloadLength` bytes (token + length + payload),
 * so callers can check a large payload against a size budget before building the element. */
export function wbxmlOpaqueSize(payloadLength: number): number {
    return 1 + mbUintSize(payloadLength) + payloadLength;
}

/**
 * Encodes a `WbxmlElement` tree into a WBXML byte stream, per MS-ASWBXML's encoding algorithm. Emits the
 * fixed EAS document header (`version=1.3, publicid=unknown, charset=UTF-8, empty string table`) followed by
 * the token stream for the given root element, switching code pages only when the page actually changes from
 * whatever was last active (starting from `AirSync`, page 0, the implicit default per spec).
 *
 * Output is accumulated as a list of `Buffer` chunks (token bytes batched in a small scratch array, text/opaque
 * payloads appended whole) and joined once at the end, so large payloads are never copied byte-by-byte. An
 * optional `maxBytes` bounds the output size, throwing `WbxmlSizeLimitError` as soon as it would be exceeded.
 *
 * @author Jean-Philippe Steinmetz
 */
export class WbxmlEncoder {
    private readonly maxBytes: number;
    private chunks: Buffer[] = [];
    private scratch: number[] = [];
    private size = 0;
    private currentPage = 0;

    constructor(options: WbxmlEncoderOptions = {}) {
        const maxBytes = options.maxBytes ?? Infinity;
        if (maxBytes !== Infinity && !(Number.isInteger(maxBytes) && maxBytes > 0)) {
            throw new RangeError(`WbxmlEncoder: option maxBytes must be a positive integer or Infinity, got ${maxBytes}`);
        }
        this.maxBytes = maxBytes;
    }

    public encode(root: WbxmlElement): Buffer {
        this.chunks = [];
        this.scratch = [];
        this.size = 0;
        this.currentPage = 0;
        try {
            // version=0x03 (WBXML 1.3, what real ActiveSync traffic uses despite MS-ASWBXML referencing 1.2),
            // publicid=0x01 (mb_u_int32 value 1: "unknown or missing" - the only form ActiveSync ever sends),
            // charset=0x6A (IANA MIBenum 106: UTF-8), string table length=0x00 (ActiveSync never uses one -
            // inline STR_I tokens carry every string literal instead).
            this.writeByte(0x03);
            this.writeByte(0x01);
            this.writeByte(0x6a);
            this.writeByte(0x00);
            this.writeElement(root);
            this.flush();
            return Buffer.concat(this.chunks, this.size);
        } finally {
            // Don't retain references to the caller's payload buffers between calls.
            this.chunks = [];
            this.scratch = [];
        }
    }

    /** Accounts for `length` more output bytes, throwing before anything is appended if that would exceed
     * `maxBytes`. */
    private reserve(length: number): void {
        if (this.size + length > this.maxBytes) {
            throw new WbxmlSizeLimitError(this.maxBytes);
        }
        this.size += length;
    }

    private writeByte(byte: number): void {
        this.reserve(1);
        this.scratch.push(byte);
        if (this.scratch.length >= WBXML_ENCODER_SCRATCH_SIZE) {
            this.flush();
        }
    }

    /** Appends a payload as its own chunk, after flushing any pending token bytes to preserve ordering. */
    private writeBuffer(data: Buffer): void {
        this.reserve(data.length);
        this.flush();
        this.chunks.push(data);
    }

    private flush(): void {
        if (this.scratch.length > 0) {
            this.chunks.push(Buffer.from(this.scratch));
            this.scratch = [];
        }
    }

    private writeElement(el: WbxmlElement): void {
        if (el.page !== this.currentPage) {
            this.writeByte(SWITCH_PAGE);
            this.writeByte(el.page);
            this.currentPage = el.page;
        }

        const code = codeForTagName(el.page, el.tag);
        const hasContent = el.children.length > 0 || el.text !== undefined || el.opaque !== undefined;
        this.writeByte(hasContent ? code | CONTENT_FLAG : code);
        if (!hasContent) {
            return;
        }

        if (el.text !== undefined) {
            this.writeStrI(el.text);
        } else if (el.opaque !== undefined) {
            this.writeOpaque(el.opaque);
        } else {
            for (const child of el.children) {
                this.writeElement(child);
            }
        }
        this.writeByte(END);
    }

    /** A NUL byte terminates a WBXML inline string, so any U+0000 in `text` (e.g. a label name or subject
     * controlled by another user) would end the string early and let the remaining bytes be parsed as tokens.
     * UTF-8 never produces a 0x00 byte for any other code point, so stripping U+0000 is sufficient. */
    private writeStrI(text: string): void {
        this.writeByte(STR_I);
        this.writeBuffer(Buffer.from(text.split(NUL).join(""), "utf-8"));
        this.writeByte(0x00);
    }

    private writeOpaque(data: Buffer): void {
        this.writeByte(OPAQUE);
        this.writeMbUint(data.length);
        this.writeBuffer(data);
    }

    /** Encodes `value` as a WBXML multi-byte unsigned integer (`mb_u_int32`): base-128 digits, most
     * significant group first, every byte but the last carrying the 0x80 continuation bit. */
    private writeMbUint(value: number): void {
        const groups: number[] = [value & 0x7f];
        value = Math.floor(value / 128);
        while (value > 0) {
            groups.unshift((value & 0x7f) | 0x80);
            value = Math.floor(value / 128);
        }
        for (const group of groups) {
            this.writeByte(group);
        }
    }
}
