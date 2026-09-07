///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// TasksSyncAdapter is pure mapping logic with no DI/DB dependency - toApplicationData is already exercised
// end-to-end via test/routes/{mongo,sql}/EasRoute.test.ts's real Sync command tests; this file is reserved for
// fromApplicationData's own ghosting/error-path edge cases - see the identical rationale in
// ContactsSyncAdapter.test.ts.
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { element, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { TasksSyncAdapter } from "../../src/adapters/TasksSyncAdapter.js";
import { TaskPriority } from "@rapidmx/restapi";

const adapter = new TasksSyncAdapter();

function appData(children: WbxmlElement[]): WbxmlElement {
    return element(WbxmlCodePage.AirSync, "ApplicationData", children);
}

function task(tag: string, value: string): WbxmlElement {
    return textElement(WbxmlCodePage.Tasks, tag, value);
}

describe("TasksSyncAdapter Tests", () => {
    it("Reports the Tasks collection class.", () => {
        expect(adapter.collectionClass).toBe("Tasks");
    });

    describe("fromApplicationData", () => {
        it("Parses Subject/Complete/UtcDueDate/Importance when present.", () => {
            const el = appData([
                task("Subject", "Buy milk"),
                task("Complete", "1"),
                task("UtcDueDate", "20260102T000000Z"),
                task("Importance", "2"),
            ]);
            const partial = adapter.fromApplicationData(el);
            expect(partial.title).toBe("Buy milk");
            expect(partial.completed).toBe(true);
            expect(partial.dueDate?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
            expect(partial.priority).toBe(TaskPriority.HIGH);
        });

        it("Interprets Complete '0' as false.", () => {
            expect(adapter.fromApplicationData(appData([task("Complete", "0")])).completed).toBe(false);
        });

        it("Leaves a field untouched when its tag is absent.", () => {
            expect(adapter.fromApplicationData(appData([]))).toEqual({});
        });

        it("Throws for an unrecognized Importance value.", () => {
            const el = appData([task("Importance", "99")]);
            expect(() => adapter.fromApplicationData(el)).toThrow(/unrecognized importance/i);
        });

        it("Sets reminderDate from ReminderTime when present.", () => {
            const el = appData([task("ReminderSet", "1"), task("ReminderTime", "20260101T080000Z")]);
            expect(adapter.fromApplicationData(el).reminderDate?.toISOString()).toBe("2026-01-01T08:00:00.000Z");
        });

        it("Explicitly clears reminderDate (to null, not undefined) when ReminderSet is '0' with no ReminderTime.", () => {
            // null, not undefined: TypeORM silently drops an undefined-valued key from its generated SQL
            // UPDATE, so undefined would leave a stale reminderDate in place on the SQL backend - see this
            // adapter's own doc comment on fromApplicationData.
            const el = appData([task("ReminderSet", "0")]);
            const partial = adapter.fromApplicationData(el);
            expect("reminderDate" in partial).toBe(true);
            expect(partial.reminderDate).toBeNull();
        });

        it("Leaves reminderDate untouched when neither ReminderSet nor ReminderTime is present.", () => {
            const partial = adapter.fromApplicationData(appData([]));
            expect("reminderDate" in partial).toBe(false);
        });

        it("Parses body from the AirSyncBase Body element.", () => {
            const el = appData([
                element(WbxmlCodePage.AirSyncBase, "Body", [
                    textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                    textElement(WbxmlCodePage.AirSyncBase, "Data", "Get 2% milk"),
                ]),
            ]);
            expect(adapter.fromApplicationData(el).body).toBe("Get 2% milk");
        });

        it("Leaves body untouched when no Body element is present.", () => {
            expect(adapter.fromApplicationData(appData([])).body).toBeUndefined();
        });
    });
});
