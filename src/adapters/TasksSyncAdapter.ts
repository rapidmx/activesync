///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { fromCompactDateTime, toCompactDateTime } from "../CompactDateTime.js";
import type { EasCollectionSyncAdapter } from "./EasCollectionSyncAdapter.js";
import { type Task, TaskPriority } from "@rapidmx/restapi";

/** MS-ASTASK `Importance` reuses the same 0/1/2 scale as MS-ASEMAIL's `Importance` (see `EmailSyncAdapter`'s
 * own identical table) - Low/Normal/High. */
const IMPORTANCE_CODES: Record<TaskPriority, string> = {
    [TaskPriority.LOW]: "0",
    [TaskPriority.NORMAL]: "1",
    [TaskPriority.HIGH]: "2",
};

const IMPORTANCE_FROM_CODE: Record<string, TaskPriority> = Object.fromEntries(
    Object.entries(IMPORTANCE_CODES).map(([k, v]) => [v, k as TaskPriority]),
);

/**
 * Maps `Task` to/from the EAS `Sync` `Tasks` collection class (MS-ASTASK).
 *
 * **Pragmatic subset**: only the `Utc*` (UTC Compact DateTime) variant of each date field is emitted, not the
 * paired local-time variant MS-ASTASK also defines (`DueDate`/`StartDate` alongside `UtcDueDate`/
 * `UtcStartDate`) - this library doesn't track a per-task timezone to correctly localize the non-UTC variant,
 * and a real device already treats the `Utc*` field as authoritative. Recurring tasks are not synced (a task's
 * `Recurrence` element mirrors Calendar's, itself already a pragmatic subset there - deferred further here).
 *
 * @author Jean-Philippe Steinmetz
 */
export class TasksSyncAdapter implements EasCollectionSyncAdapter<Task> {
    public readonly collectionClass = "Tasks";

    public toApplicationData(task: Task): WbxmlElement {
        return element(WbxmlCodePage.AirSync, "ApplicationData", [
            textElement(WbxmlCodePage.Tasks, "Subject", task.title),
            textElement(WbxmlCodePage.Tasks, "Complete", task.completed ? "1" : "0"),
            ...(task.completed ? [textElement(WbxmlCodePage.Tasks, "DateCompleted", toCompactDateTime(task.dateModified))] : []),
            ...(task.dueDate ? [textElement(WbxmlCodePage.Tasks, "UtcDueDate", toCompactDateTime(task.dueDate))] : []),
            textElement(WbxmlCodePage.Tasks, "Importance", IMPORTANCE_CODES[task.priority]),
            textElement(WbxmlCodePage.Tasks, "Sensitivity", "0"),
            textElement(WbxmlCodePage.Tasks, "ReminderSet", task.reminderDate ? "1" : "0"),
            ...(task.reminderDate ? [textElement(WbxmlCodePage.Tasks, "ReminderTime", toCompactDateTime(task.reminderDate))] : []),
            ...(task.body
                ? [
                      element(WbxmlCodePage.AirSyncBase, "Body", [
                          textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                          textElement(WbxmlCodePage.AirSyncBase, "EstimatedDataSize", String(Buffer.byteLength(task.body, "utf8"))),
                          textElement(WbxmlCodePage.AirSyncBase, "Data", task.body),
                      ]),
                  ]
                : []),
        ]);
    }

    /**
     * Reverse of `toApplicationData`. `DateCompleted` is never parsed back - it's `task.dateModified` echoed
     * out, not an independent field this library's own `Task` model has room to store separately, so a client
     * setting `Complete` is enough on its own. `ReminderSet="0"` (with no `ReminderTime`) is treated as an
     * explicit "clear the reminder" signal (`reminderDate: undefined` in the returned partial, which - unlike
     * simply omitting the key - does override an existing reminder when merged onto `existing` for a `Change`)
     * since MS-ASTASK gives no other way to express removing a reminder; `UtcDueDate` has no equivalent
     * explicit-clear signal and so can only be set, never cleared, via `Sync` - a real, narrower gap than
     * `reminderDate`'s, documented here rather than silently accepted.
     */
    public fromApplicationData(el: WbxmlElement): Partial<Task> {
        const partial: Partial<Task> = {};

        const subject = childText(el, "Subject");
        if (subject !== undefined) partial.title = subject;
        const complete = childText(el, "Complete");
        if (complete !== undefined) partial.completed = complete === "1";
        const utcDueDate = childText(el, "UtcDueDate");
        if (utcDueDate !== undefined) partial.dueDate = fromCompactDateTime(utcDueDate);
        const importance = childText(el, "Importance");
        if (importance !== undefined) {
            const mapped = IMPORTANCE_FROM_CODE[importance];
            if (!mapped) {
                throw new Error(`Unrecognized Importance value: '${importance}'`);
            }
            partial.priority = mapped;
        }

        const reminderSet = childText(el, "ReminderSet");
        const reminderTime = childText(el, "ReminderTime");
        if (reminderTime !== undefined) {
            partial.reminderDate = fromCompactDateTime(reminderTime);
        } else if (reminderSet === "0") {
            partial.reminderDate = undefined;
        }

        const bodyEl = findChild(el, "Body");
        const body = bodyEl ? childText(bodyEl, "Data") : undefined;
        if (body !== undefined) partial.body = body;

        return partial;
    }
}
