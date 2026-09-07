///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { element, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { toCompactDateTime } from "../CompactDateTime.js";
import type { EasCollectionSyncAdapter } from "./EasCollectionSyncAdapter.js";
import { type Task, TaskPriority } from "@rapidmx/restapi";

/** MS-ASTASK `Importance` reuses the same 0/1/2 scale as MS-ASEMAIL's `Importance` (see `EmailSyncAdapter`'s
 * own identical table) - Low/Normal/High. */
const IMPORTANCE_CODES: Record<TaskPriority, string> = {
    [TaskPriority.LOW]: "0",
    [TaskPriority.NORMAL]: "1",
    [TaskPriority.HIGH]: "2",
};

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
}
