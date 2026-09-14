///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash } from "crypto";
import { BaseEntity, type RepoUtils } from "@rapidrest/service-core";

/**
 * Inline copies of small restapi helpers that the `@rapidmx/restapi` 0.9.0 this plugin builds against doesn't export
 * yet. Each matches restapi's source exactly - replace the copy with restapi's export once the dependency is bumped.
 */

/** The longest value `boundIndexedValue()` stores verbatim (restapi `util/ConversationUtils.ts`). */
export const MAX_INDEXED_VALUE_LENGTH: number = 255;

/**
 * Returns `value` unchanged when it's at most `MAX_INDEXED_VALUE_LENGTH` characters, otherwise
 * `sha256:<64 hex digits>` of its UTF-8 bytes - how restapi stores indexed identifiers from untrusted mail/calendar
 * data (`Message.messageId`, `Message.conversationId`, `CalendarEvent.icalUid`). Idempotent, so a lookup value passed
 * through it matches the stored one. Copy of restapi's `boundIndexedValue()` (`util/ConversationUtils.ts`).
 */
export function boundIndexedValue<T extends string | null | undefined>(value: T): T {
    if (typeof value !== "string" || value.length <= MAX_INDEXED_VALUE_LENGTH) {
        return value;
    }
    return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as T;
}

/**
 * `row` as an instance of `repo`'s model class, for use as the `existing` argument of `RepoUtils.update()`.
 *
 * `update()` only enforces its optimistic lock (a version mismatch -> 409, a version-filtered write, and the
 * `version`/`dateModified` bump) when `existing instanceof BaseEntity`. The Mongo backend's `find()`/`findOne()` return
 * plain documents, so passing one straight through silently turns a version-checked write into an unconditional
 * overwrite that other devices' change streams never see. SQL reads already return entity instances, which pass
 * through as-is. Copy of restapi's `asEntity()` (`util/EntityUtils.ts`).
 */
export function asEntity<T>(repo: RepoUtils<any>, row: T): T {
    if (row instanceof BaseEntity) {
        return row;
    }
    const modelClass: any = (repo as any).modelClass;
    return modelClass ? new modelClass(row) : row;
}
