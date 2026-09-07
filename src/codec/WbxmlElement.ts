///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * A minimal, tagged-tree representation of one WBXML element, decoupled from the wire format's binary token
 * encoding — `WbxmlEncoder`/`WbxmlDecoder` are the only code that ever deals in raw bytes; every EAS command
 * handler works against this tree.
 *
 * Deliberately does not model WBXML attributes: MS-ASWBXML's own algorithm description confirms ActiveSync
 * never uses the attribute mechanism (every element's data is carried as child elements or inline text), so
 * there is nothing for an `attrs` field to represent here.
 *
 * A given element is expected to carry exactly one of `children` (nested elements - the common case for a
 * structural container like `Sync`/`Collection`), `text` (a single inline string value - the common case for
 * a leaf field like `SyncKey`/`ServerId`), or `opaque` (raw binary content - used only for `ItemOperations`
 * `Data` and similar binary payloads). Real ActiveSync XML is data-oriented, not document-oriented, so this
 * library never needs to represent mixed content (an element with both nested tags and inline text).
 *
 * @author Jean-Philippe Steinmetz
 */
export interface WbxmlElement {
    /** The `WbxmlCodePage` this element's tag belongs to. */
    page: number;
    /** The tag name, as registered in `WbxmlCodePages.ts` for `page`. */
    tag: string;
    /** Nested elements, in document order. Empty for a leaf/empty element. */
    children: WbxmlElement[];
    /** Inline string content (WBXML `STR_I`), for a leaf element carrying a single text value. */
    text?: string;
    /** Raw binary content (WBXML `OPAQUE`), for a leaf element carrying binary data. */
    opaque?: Buffer;
}

/** Constructs a structural element with nested children (e.g. `<Collection>...</Collection>`). */
export function element(page: number, tag: string, children: WbxmlElement[] = []): WbxmlElement {
    return { page, tag, children };
}

/** Constructs a leaf element carrying a single inline string value (e.g. `<SyncKey>1</SyncKey>`). */
export function textElement(page: number, tag: string, text: string): WbxmlElement {
    return { page, tag, children: [], text };
}

/** Constructs a leaf element carrying raw binary content (e.g. `<Data>...</Data>` in `ItemOperations`). */
export function opaqueElement(page: number, tag: string, opaque: Buffer): WbxmlElement {
    return { page, tag, children: [], opaque };
}

/** Finds the first direct child of `parent` with the given tag name, or `undefined` if none exists. Does not
 * search recursively — WBXML/EAS field lookups are always relative to a specific known parent element. */
export function findChild(parent: WbxmlElement, tag: string): WbxmlElement | undefined {
    return parent.children.find((child) => child.tag === tag);
}

/** Finds every direct child of `parent` with the given tag name (e.g. every `Collection` under
 * `Collections`). */
export function findChildren(parent: WbxmlElement, tag: string): WbxmlElement[] {
    return parent.children.filter((child) => child.tag === tag);
}

/** Shorthand for `findChild(parent, tag)?.text`, the common case of reading a leaf field's string value. */
export function childText(parent: WbxmlElement, tag: string): string | undefined {
    return findChild(parent, tag)?.text;
}
