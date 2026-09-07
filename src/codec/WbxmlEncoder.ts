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

/** Bit flags folded into a tag token byte alongside its 6-bit code (MS-ASWBXML §2.1.2.2 "Tag Format"). Only
 * `CONTENT_FLAG` is ever set by this encoder - ActiveSync's WBXML profile never uses attributes. */
const CONTENT_FLAG = 0x40;

/**
 * Encodes a `WbxmlElement` tree into a WBXML byte stream, per MS-ASWBXML's encoding algorithm. Emits the
 * fixed EAS document header (`version=1.3, publicid=unknown, charset=UTF-8, empty string table`) followed by
 * the token stream for the given root element, switching code pages only when the page actually changes from
 * whatever was last active (starting from `AirSync`, page 0, the implicit default per spec).
 *
 * @author Jean-Philippe Steinmetz
 */
export class WbxmlEncoder {
    private bytes: number[] = [];
    private currentPage = 0;

    public encode(root: WbxmlElement): Buffer {
        // version=0x03 (WBXML 1.3, what real ActiveSync traffic uses despite MS-ASWBXML referencing 1.2),
        // publicid=0x01 (mb_u_int32 value 1: "unknown or missing" - the only form ActiveSync ever sends),
        // charset=0x6A (IANA MIBenum 106: UTF-8), string table length=0x00 (ActiveSync never uses one -
        // inline STR_I tokens carry every string literal instead).
        this.bytes = [0x03, 0x01, 0x6a, 0x00];
        this.currentPage = 0;
        this.writeElement(root);
        return Buffer.from(this.bytes);
    }

    private writeElement(el: WbxmlElement): void {
        if (el.page !== this.currentPage) {
            this.bytes.push(SWITCH_PAGE, el.page);
            this.currentPage = el.page;
        }

        const code = codeForTagName(el.page, el.tag);
        const hasContent = el.children.length > 0 || el.text !== undefined || el.opaque !== undefined;
        this.bytes.push(hasContent ? code | CONTENT_FLAG : code);
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
        this.bytes.push(END);
    }

    private writeStrI(text: string): void {
        this.bytes.push(STR_I);
        for (const byte of Buffer.from(text, "utf-8")) {
            this.bytes.push(byte);
        }
        this.bytes.push(0x00);
    }

    private writeOpaque(data: Buffer): void {
        this.bytes.push(OPAQUE);
        this.writeMbUint(data.length);
        for (const byte of data) {
            this.bytes.push(byte);
        }
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
        this.bytes.push(...groups);
    }
}
