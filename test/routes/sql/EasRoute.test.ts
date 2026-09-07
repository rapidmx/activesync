///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// See the identical file header in test/routes/mongo/EasRoute.test.ts for the full rationale - this verifies
// the same BaseEasRoute transport plumbing and Provision/FolderSync command behavior on the SQL-backed
// variant.
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import {
    Server,
    ObjectFactory,
    ConnectionManager,
    isSqlDataSource,
    ACLAction,
    AccessControlListSQL,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import {
    AttachmentSQL,
    CalendarEventSQL,
    ContactSQL,
    DeviceSyncStateSQL,
    FolderSQL,
    MailboxSQL,
    MessageSQL,
    TaskSQL,
} from "@rapidmx/restapi/sql";
import { registerTestDoubles, RecordingMailTransport, InMemoryBlobStore } from "../../testDoubles.js";
import { WbxmlEncoder } from "../../../src/codec/WbxmlEncoder.js";
import { WbxmlDecoder } from "../../../src/codec/WbxmlDecoder.js";
import { element, textElement, opaqueElement, findChild, findChildren, childText, type WbxmlElement } from "../../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../../src/codec/WbxmlCodePages.js";
import {
    FolderType,
    MessageImportance,
    RecipientType,
    ContactAddressKind,
    AttendeeRole,
    AttendeeResponseStatus,
    BusyStatus,
    RecurrenceFrequency,
    TaskPriority,
} from "@rapidmx/restapi";

describe("Route:EasRouteSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/eas";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let messageRepo: Repository<MessageSQL>;
    let contactRepo: Repository<ContactSQL>;
    let calendarEventRepo: Repository<CalendarEventSQL>;
    let taskRepo: Repository<TaskSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;
    let deviceSyncStateRepo: Repository<DeviceSyncStateSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };

    /** See the identical helper in test/routes/mongo/EasRoute.test.ts for why the ACL seed matters here. */
    const createMailbox = async function (ownerUid: string): Promise<MailboxSQL> {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxSQL = await mailboxRepo.save(obj);
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }],
            parentUid: "Mailbox",
        } as any);
        return result;
    };

    const createFolderWithAcl = async function (mailboxUid: string, data: Partial<FolderSQL>): Promise<FolderSQL> {
        const result: FolderSQL = await folderRepo.save(
            new FolderSQL({ mailboxUid, unreadCount: 0, totalCount: 0, syncKeyVersion: 0, ...data } as any),
        );
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [],
            parentUid: mailboxUid,
        } as any);
        return result;
    };

    /** See the identical helper in test/routes/mongo/EasRoute.test.ts. */
    const createMessage = async function (mailboxUid: string, folderUid: string, data?: Partial<MessageSQL>): Promise<MessageSQL> {
        return await messageRepo.save(
            new MessageSQL({
                mailboxUid,
                folderUid,
                messageId: `${uuid.v4()}@example.com`,
                subject: "Test Subject",
                from: { address: "sender@example.com", displayName: "Sender", type: RecipientType.TO },
                recipients: [{ address: "owner@example.com", type: RecipientType.TO }],
                sentDate: new Date(),
                receivedDate: new Date(),
                bodyBlobKey: `bodies/${uuid.v4()}`,
                bodyPreview: "Hello world",
                flags: { read: false, flagged: false, answered: false, forwarded: false },
                importance: MessageImportance.NORMAL,
                references: [],
                hasAttachments: false,
                ...data,
            } as any),
        );
    };

    /** See the identical helper in test/routes/mongo/EasRoute.test.ts. */
    const createContact = async function (mailboxUid: string, folderUid: string, data?: Partial<ContactSQL>): Promise<ContactSQL> {
        return await contactRepo.save(
            new ContactSQL({
                mailboxUid,
                folderUid,
                displayName: "Test Contact",
                emails: [],
                phones: [],
                addresses: [],
                ...data,
            } as any),
        );
    };

    /** See the identical helper in test/routes/mongo/EasRoute.test.ts. */
    const createCalendarEvent = async function (
        mailboxUid: string,
        folderUid: string,
        data?: Partial<CalendarEventSQL>,
    ): Promise<CalendarEventSQL> {
        return await calendarEventRepo.save(
            new CalendarEventSQL({
                mailboxUid,
                folderUid,
                title: "Test Event",
                startDate: new Date("2026-01-01T10:00:00.000Z"),
                endDate: new Date("2026-01-01T11:00:00.000Z"),
                timezone: "UTC",
                organizer: { address: "owner@example.com", type: RecipientType.TO },
                attendees: [],
                icalUid: `${uuid.v4()}@example.com`,
                ...data,
            } as any),
        );
    };

    /** See the identical helper in test/routes/mongo/EasRoute.test.ts. */
    const createTask = async function (mailboxUid: string, folderUid: string, data?: Partial<TaskSQL>): Promise<TaskSQL> {
        return await taskRepo.save(
            new TaskSQL({
                mailboxUid,
                folderUid,
                title: "Test Task",
                ...data,
            } as any),
        );
    };

    const blobStore = function (): InMemoryBlobStore {
        return objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!;
    };

    /** See the identical helper in test/routes/mongo/EasRoute.test.ts. */
    const createAttachment = async function (
        messageUid: string,
        folderUid: string,
        mailboxUid: string,
        content: Buffer,
        data?: Partial<AttachmentSQL>,
    ): Promise<AttachmentSQL> {
        const blobKey = `attachments/${uuid.v4()}`;
        await blobStore().put(blobKey, content, { contentType: "application/octet-stream" });
        return await attachmentRepo.save(
            new AttachmentSQL({
                messageUid,
                folderUid,
                mailboxUid,
                filename: "test.txt",
                mimeType: "text/plain",
                sizeBytes: content.length,
                blobKey,
                isInline: false,
                ...data,
            } as any),
        );
    };

    /** See the identical helper in test/routes/mongo/EasRoute.test.ts. */
    const postWbxml = async function (cmd: string, deviceId: string, requestBody?: WbxmlElement): Promise<WbxmlElement> {
        const req = request(server.getApplication())
            .post(`${baseUrl}?Cmd=${cmd}&DeviceId=${deviceId}`)
            .set("Authorization", "jwt " + ownerToken)
            .set("Content-Type", "application/vnd.ms-sync.wbxml");
        const result = requestBody ? await req.send(new WbxmlEncoder().encode(requestBody)) : await req;
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        return new WbxmlDecoder().decode(Buffer.from(result.body));
    };

    /** See the identical helper in test/routes/mongo/EasRoute.test.ts. */
    const provisionDevice = async function (deviceId: string): Promise<void> {
        const phase1 = await postWbxml(
            "Provision",
            deviceId,
            element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyType", "MS-EAS-Provisioning-WBXML"),
                    ]),
                ]),
            ]),
        );
        const policyKey = childText(findChild(findChild(phase1, "Policies")!, "Policy")!, "PolicyKey")!;
        await postWbxml(
            "Provision",
            deviceId,
            element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyType", "MS-EAS-Provisioning-WBXML"),
                        textElement(WbxmlCodePage.Provision, "PolicyKey", policyKey),
                        textElement(WbxmlCodePage.Provision, "Status", "1"),
                    ]),
                ]),
            ]),
        );
    };

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            folderRepo = conn.getRepository(FolderSQL);
            messageRepo = conn.getRepository(MessageSQL);
            contactRepo = conn.getRepository(ContactSQL);
            calendarEventRepo = conn.getRepository(CalendarEventSQL);
            taskRepo = conn.getRepository(TaskSQL);
            attachmentRepo = conn.getRepository(AttachmentSQL);
            deviceSyncStateRepo = conn.getRepository(DeviceSyncStateSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
        const aclConn: any = connMgr?.connections.get("acl");
        if (isSqlDataSource(aclConn)) {
            aclRepo = aclConn.getRepository(AccessControlListSQL);
        } else {
            throw new Error("Could not find sql acl connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await deviceSyncStateRepo.clear();
        await attachmentRepo.clear();
        await taskRepo.clear();
        await calendarEventRepo.clear();
        await contactRepo.clear();
        await messageRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
        await aclRepo.clear();
        // See the identical reset in test/routes/mongo/EasRoute.test.ts.
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport");
        if (transport) {
            transport.sent = [];
        }
    });

    describe("OPTIONS", () => {
        // See the identical note in test/routes/mongo/EasRoute.test.ts.
        it("Is answered by the framework's generic CORS preflight handler, not by this route.", async () => {
            const result = await request(server.getApplication()).options(baseUrl);
            expect(result.status).toBe(204);
            expect(result.headers["ms-asprotocolversions"]).toBeUndefined();
        });
    });

    describe("POST (dispatch)", () => {
        it("Requires authentication.", async () => {
            const result = await request(server.getApplication()).post(`${baseUrl}?Cmd=FolderSync&DeviceId=dev1`);
            expect(result.status).toBe(401);
        });

        it("Requires both Cmd and DeviceId query parameters.", async () => {
            await createMailbox(owner.uid);

            const missingCmd = await request(server.getApplication())
                .post(`${baseUrl}?DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);
            expect(missingCmd.status).toBe(400);

            const missingDeviceId = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=FolderSync`)
                .set("Authorization", "jwt " + ownerToken);
            expect(missingDeviceId.status).toBe(400);
        });

        it("Returns 404 when the caller owns no mailbox.", async () => {
            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=FolderSync&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);
            expect(result.status).toBe(404);
        });

        it("Creates a new (unprovisioned) DeviceSyncState on first contact from a device.", async () => {
            const mailbox = await createMailbox(owner.uid);

            await request(server.getApplication())
                .post(`${baseUrl}?Cmd=FolderSync&DeviceId=dev1&DeviceType=TestPhone`)
                .set("Authorization", "jwt " + ownerToken);

            const found = await deviceSyncStateRepo.findOne({ where: { mailboxUid: mailbox.uid, deviceId: "dev1" } });
            expect(found).not.toBeNull();
            expect(found?.deviceType).toBe("TestPhone");
            expect(found?.provisioned).toBe(false);
            expect(found?.folderSyncKeys).toEqual({});
        });

        it("Uses only the first value of a repeated query parameter (e.g. a client sending DeviceType twice).", async () => {
            const mailbox = await createMailbox(owner.uid);

            await request(server.getApplication())
                .post(`${baseUrl}?Cmd=FolderSync&DeviceId=dev1&DeviceType=First&DeviceType=Second`)
                .set("Authorization", "jwt " + ownerToken);

            const found = await deviceSyncStateRepo.findOne({ where: { mailboxUid: mailbox.uid, deviceId: "dev1" } });
            expect(found?.deviceType).toBe("First");
        });

        it("Rejects a non-Provision/Settings command from an unprovisioned device with HTTP 449 (Retry With).", async () => {
            await createMailbox(owner.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=FolderSync&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(449);
        });

        it("Allows Settings through the provisioning gate even for an unprovisioned device.", async () => {
            await createMailbox(owner.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=Settings&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
        });

        it("Returns 501 for a recognized-but-deferred command (ResolveRecipients) once the device is already provisioned.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await deviceSyncStateRepo.save(
                new DeviceSyncStateSQL({
                    mailboxUid: mailbox.uid,
                    deviceId: "dev1",
                    deviceType: "TestPhone",
                    folderSyncKeys: {},
                    provisioned: true,
                }),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=ResolveRecipients&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(501);
        });

        it("Reuses the same DeviceSyncState across requests from the same (mailbox, device) pair rather than duplicating it.", async () => {
            const mailbox = await createMailbox(owner.uid);

            await request(server.getApplication())
                .post(`${baseUrl}?Cmd=Settings&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);
            await request(server.getApplication())
                .post(`${baseUrl}?Cmd=Settings&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);

            const all = await deviceSyncStateRepo.find({ where: { mailboxUid: mailbox.uid, deviceId: "dev1" } });
            expect(all.length).toBe(1);
        });
    });

    describe("Provision command", () => {
        it("Completes the two-phase handshake and marks the device provisioned.", async () => {
            await createMailbox(owner.uid);

            const phase1Request = element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyType", "MS-EAS-Provisioning-WBXML"),
                    ]),
                ]),
            ]);
            const phase1Response = await postWbxml("Provision", "dev1", phase1Request);
            expect(childText(phase1Response, "Status")).toBe("1");
            const phase1Policy = findChild(findChild(phase1Response, "Policies")!, "Policy")!;
            const policyKey = childText(phase1Policy, "PolicyKey");
            expect(policyKey).toBeTruthy();

            const afterPhase1 = await deviceSyncStateRepo.findOne({ where: { deviceId: "dev1" } });
            expect(afterPhase1?.policyKey).toBe(policyKey);
            expect(afterPhase1?.provisioned).toBe(false);

            const phase2Request = element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyType", "MS-EAS-Provisioning-WBXML"),
                        textElement(WbxmlCodePage.Provision, "PolicyKey", policyKey!),
                        textElement(WbxmlCodePage.Provision, "Status", "1"),
                    ]),
                ]),
            ]);
            const phase2Response = await postWbxml("Provision", "dev1", phase2Request);
            expect(childText(phase2Response, "Status")).toBe("1");
            const phase2Policy = findChild(findChild(phase2Response, "Policies")!, "Policy")!;
            expect(childText(phase2Policy, "PolicyKey")).toBe(policyKey);

            const afterPhase2 = await deviceSyncStateRepo.findOne({ where: { deviceId: "dev1" } });
            expect(afterPhase2?.provisioned).toBe(true);
        });

        it("Rejects phase 2 with a stale/incorrect PolicyKey without provisioning the device.", async () => {
            await createMailbox(owner.uid);

            await postWbxml(
                "Provision",
                "dev1",
                element(WbxmlCodePage.Provision, "Provision", [
                    element(WbxmlCodePage.Provision, "Policies", [
                        element(WbxmlCodePage.Provision, "Policy", [
                            textElement(WbxmlCodePage.Provision, "PolicyType", "MS-EAS-Provisioning-WBXML"),
                        ]),
                    ]),
                ]),
            );

            const badPhase2Response = await postWbxml(
                "Provision",
                "dev1",
                element(WbxmlCodePage.Provision, "Provision", [
                    element(WbxmlCodePage.Provision, "Policies", [
                        element(WbxmlCodePage.Provision, "Policy", [
                            textElement(WbxmlCodePage.Provision, "PolicyType", "MS-EAS-Provisioning-WBXML"),
                            textElement(WbxmlCodePage.Provision, "PolicyKey", "not-the-real-key"),
                            textElement(WbxmlCodePage.Provision, "Status", "1"),
                        ]),
                    ]),
                ]),
            );

            expect(childText(badPhase2Response, "Status")).toBe("2");
            const state = await deviceSyncStateRepo.findOne({ where: { deviceId: "dev1" } });
            expect(state?.provisioned).toBe(false);
        });
    });

    describe("FolderSync command", () => {
        it("Treats a request sent with no WBXML body at all the same as SyncKey '0' (initial sync).", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const response = await postWbxml("FolderSync", "dev1");

            expect(childText(response, "Status")).toBe("1");
            expect(childText(response, "SyncKey")).toBeTruthy();
        });

        it("Returns a fresh SyncKey with no items on the initial (SyncKey 0) request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            await folderRepo.save(new FolderSQL({ mailboxUid: mailbox.uid, name: "Inbox", type: FolderType.INBOX, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }));

            const response = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", "0"),
                ]),
            );

            expect(childText(response, "Status")).toBe("1");
            expect(childText(response, "SyncKey")).not.toBe("0");
            expect(findChild(response, "Changes")).toBeUndefined();
        });

        it("Reports an existing folder as an Add on the first real sync round after the initial request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await folderRepo.save(
                new FolderSQL({ mailboxUid: mailbox.uid, name: "Inbox", type: FolderType.INBOX, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );

            const initial = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", "0"),
                ]),
            );
            const initialKey = childText(initial, "SyncKey")!;

            const response = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", initialKey),
                ]),
            );

            expect(childText(response, "Status")).toBe("1");
            expect(childText(response, "SyncKey")).not.toBe(initialKey);
            const changes = findChild(response, "Changes")!;
            expect(childText(changes, "Count")).toBe("1");
            const add = findChild(changes, "Add")!;
            expect(childText(add, "ServerId")).toBe(folder.uid);
            expect(childText(add, "DisplayName")).toBe("Inbox");
            expect(childText(add, "ParentId")).toBe("0");
            expect(childText(add, "Type")).toBe("2");
        });

        it("Reports a folder renamed via the REST API as an Update on the next sync round.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Archive", type: FolderType.USER });
            // Backdated well outside computeChanges()'s NEWLY_CREATED_TOLERANCE_MS window, so the rename below
            // (which bumps only dateModified) is unambiguously an Update, not indistinguishable from a
            // brand-new Add - a real device wouldn't rename a folder within the same second it was created,
            // and this test shouldn't depend on a real wall-clock delay to reproduce that distinction.
            const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            await folderRepo.update({ uid: folder.uid }, { dateCreated: oldDate, dateModified: oldDate });

            const initial = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", "0"),
                ]),
            );
            const afterAdd = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", childText(initial, "SyncKey")!),
                ]),
            );

            const renameResult = await request(server.getApplication())
                .put(`/sql/folders/${folder.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: folder.uid, version: folder.version, name: "Renamed" });
            expect(renameResult.status).toBe(200);

            const response = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", childText(afterAdd, "SyncKey")!),
                ]),
            );

            const changes = findChild(response, "Changes")!;
            expect(childText(changes, "Count")).toBe("1");
            const update = findChild(changes, "Update")!;
            expect(childText(update, "ServerId")).toBe(folder.uid);
            expect(childText(update, "DisplayName")).toBe("Renamed");
        });

        it("Reports a folder deleted via the REST API as a Delete on the next sync round.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Archive", type: FolderType.USER });

            const initial = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", "0"),
                ]),
            );
            const afterAdd = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", childText(initial, "SyncKey")!),
                ]),
            );
            const keyAfterAdd = childText(afterAdd, "SyncKey")!;

            const deleteResult = await request(server.getApplication())
                .delete(`/sql/folders/${folder.uid}`)
                .set("Authorization", "jwt " + ownerToken);
            expect(deleteResult.status).toBeGreaterThanOrEqual(200);
            expect(deleteResult.status).toBeLessThan(300);

            const response = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", keyAfterAdd),
                ]),
            );

            const changes = findChild(response, "Changes")!;
            expect(childText(changes, "Count")).toBe("1");
            const del = findChild(changes, "Delete")!;
            expect(childText(del, "ServerId")).toBe(folder.uid);
        });

        it("Rejects an incorrect SyncKey with Status 3, forcing the client back to a full resync.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const response = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", "999:2020-01-01T00:00:00.000Z"),
                ]),
            );

            expect(childText(response, "Status")).toBe("3");
        });

        it("Reports no Changes element when nothing changed since the last sync.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            await folderRepo.save(
                new FolderSQL({ mailboxUid: mailbox.uid, name: "Inbox", type: FolderType.INBOX, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }),
            );

            const initial = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", "0"),
                ]),
            );
            const afterAdd = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", childText(initial, "SyncKey")!),
                ]),
            );

            const noChangeResponse = await postWbxml(
                "FolderSync",
                "dev1",
                element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                    textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", childText(afterAdd, "SyncKey")!),
                ]),
            );

            expect(childText(noChangeResponse, "Status")).toBe("1");
            expect(findChild(noChangeResponse, "Changes")).toBeUndefined();
        });
    });

    describe("Sync command", () => {
        const syncRequest = function (syncKey: string, collectionClass: string | undefined, folderUid: string | undefined): WbxmlElement {
            return element(WbxmlCodePage.AirSync, "Sync", [
                element(WbxmlCodePage.AirSync, "Collections", [
                    element(WbxmlCodePage.AirSync, "Collection", [
                        ...(collectionClass ? [textElement(WbxmlCodePage.AirSync, "Class", collectionClass)] : []),
                        textElement(WbxmlCodePage.AirSync, "SyncKey", syncKey),
                        ...(folderUid ? [textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid)] : []),
                    ]),
                ]),
            ]);
        };

        it("Returns a fresh SyncKey with no items on the initial (SyncKey 0) request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });

            const response = await postWbxml("Sync", "dev1", syncRequest("0", "Email", folder.uid));

            const collection = findChild(findChild(response, "Collections")!, "Collection")!;
            expect(childText(collection, "Status")).toBe("1");
            expect(childText(collection, "SyncKey")).not.toBe("0");
            expect(findChild(collection, "Commands")).toBeUndefined();
        });

        it("Reports an existing message as an Add on the first real sync round after the initial request.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const message = await createMessage(mailbox.uid, folder.uid, {
                subject: "Hello EAS",
                flags: { read: true, flagged: true, answered: false, forwarded: false },
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Email", folder.uid));
            const initialKey = childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!;

            const response = await postWbxml("Sync", "dev1", syncRequest(initialKey, "Email", folder.uid));

            const collection = findChild(findChild(response, "Collections")!, "Collection")!;
            expect(childText(collection, "Status")).toBe("1");
            expect(childText(collection, "SyncKey")).not.toBe(initialKey);
            const commands = findChild(collection, "Commands")!;
            const add = findChild(commands, "Add")!;
            expect(childText(add, "ServerId")).toBe(message.uid);
            const appData = findChild(add, "ApplicationData")!;
            expect(childText(appData, "Subject")).toBe("Hello EAS");
            expect(childText(appData, "From")).toBe("Sender <sender@example.com>");
            expect(childText(appData, "Read")).toBe("1");
            expect(childText(appData, "Flag")).toBe("1");
        });

        it("Reports a message deleted via the REST API as a Delete on the next sync round.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const message = await createMessage(mailbox.uid, folder.uid);

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Email", folder.uid));
            const afterAdd = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Email", folder.uid),
            );
            const keyAfterAdd = childText(findChild(findChild(afterAdd, "Collections")!, "Collection")!, "SyncKey")!;

            const deleteResult = await request(server.getApplication())
                .delete(`/sql/messages/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken);
            expect(deleteResult.status).toBeGreaterThanOrEqual(200);
            expect(deleteResult.status).toBeLessThan(300);

            const response = await postWbxml("Sync", "dev1", syncRequest(keyAfterAdd, "Email", folder.uid));

            const collection = findChild(findChild(response, "Collections")!, "Collection")!;
            const commands = findChild(collection, "Commands")!;
            const del = findChild(commands, "Delete")!;
            expect(childText(del, "ServerId")).toBe(message.uid);
        });

        it("Rejects an incorrect SyncKey with Status 3, forcing the client back to a full resync.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });

            const response = await postWbxml("Sync", "dev1", syncRequest("999:2020-01-01T00:00:00.000Z", "Email", folder.uid));

            const collection = findChild(findChild(response, "Collections")!, "Collection")!;
            expect(childText(collection, "Status")).toBe("3");
        });

        it("Returns a top-level Status 3 when the request has no Collection at all.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const response = await postWbxml(
                "Sync",
                "dev1",
                element(WbxmlCodePage.AirSync, "Sync", [element(WbxmlCodePage.AirSync, "Collections", [])]),
            );

            expect(childText(response, "Status")).toBe("3");
        });

        it("Returns a per-collection Status 4 when CollectionId is missing.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const response = await postWbxml("Sync", "dev1", syncRequest("0", "Email", undefined));

            const collection = findChild(findChild(response, "Collections")!, "Collection")!;
            expect(childText(collection, "Status")).toBe("4");
        });

        it("Returns a per-collection Status 4 for an unsupported collection Class.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Notes", type: FolderType.NOTES });

            const response = await postWbxml("Sync", "dev1", syncRequest("0", "Notes", folder.uid));

            const collection = findChild(findChild(response, "Collections")!, "Collection")!;
            expect(childText(collection, "Status")).toBe("4");
        });

        it("Reports no Commands when nothing changed since the last sync.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            await createMessage(mailbox.uid, folder.uid);

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Email", folder.uid));
            const afterAdd = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Email", folder.uid),
            );

            const noChangeResponse = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(afterAdd, "Collections")!, "Collection")!, "SyncKey")!, "Email", folder.uid),
            );

            const collection = findChild(findChild(noChangeResponse, "Collections")!, "Collection")!;
            expect(childText(collection, "Status")).toBe("1");
            expect(findChild(collection, "Commands")).toBeUndefined();
        });

        it("Reports a message updated via the REST API as a Change on the next sync round.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const message = await createMessage(mailbox.uid, folder.uid);
            // Backdated well outside computeChanges()'s NEWLY_CREATED_TOLERANCE_MS window - see the identical
            // reasoning on the FolderSync rename test above.
            const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            await messageRepo.update({ uid: message.uid }, { dateCreated: oldDate, dateModified: oldDate });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Email", folder.uid));
            const afterAdd = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Email", folder.uid),
            );

            const updateResult = await request(server.getApplication())
                .put(`/sql/messages/${message.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: message.uid, version: message.version, subject: "Updated Subject" });
            expect(updateResult.status).toBe(200);

            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(afterAdd, "Collections")!, "Collection")!, "SyncKey")!, "Email", folder.uid),
            );

            const collection = findChild(findChild(response, "Collections")!, "Collection")!;
            const commands = findChild(collection, "Commands")!;
            const change = findChild(commands, "Change")!;
            expect(childText(change, "ServerId")).toBe(message.uid);
            expect(childText(findChild(change, "ApplicationData")!, "Subject")).toBe("Updated Subject");
        });

        it("Omits To and includes Cc/plain-address From for a message with no To recipients.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            await createMessage(mailbox.uid, folder.uid, {
                from: { address: "sender@example.com", type: RecipientType.TO },
                recipients: [{ address: "cc1@example.com", type: RecipientType.CC }],
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Email", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Email", folder.uid),
            );

            const commands = findChild(findChild(findChild(response, "Collections")!, "Collection")!, "Commands")!;
            const appData = findChild(findChild(commands, "Add")!, "ApplicationData")!;
            expect(childText(appData, "From")).toBe("sender@example.com");
            expect(findChild(appData, "To")).toBeUndefined();
            expect(childText(appData, "Cc")).toBe("cc1@example.com");
        });

        const firstAddAppData = function (response: WbxmlElement): WbxmlElement {
            const commands = findChild(findChild(findChild(response, "Collections")!, "Collection")!, "Commands")!;
            return findChild(findChild(commands, "Add")!, "ApplicationData")!;
        };

        it("Reports an existing contact as an Add, mapping emails/phones/addresses/notes.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
            await createContact(mailbox.uid, folder.uid, {
                displayName: "Ada Lovelace",
                givenName: "Ada",
                surname: "Lovelace",
                company: "Analytical Engines Ltd",
                jobTitle: "Mathematician",
                emails: [{ address: "ada@example.com", type: ContactAddressKind.WORK }],
                phones: [{ phoneNumber: "555-1234", type: ContactAddressKind.HOME }],
                addresses: [{ street: "1 Babbage Way", city: "London", type: ContactAddressKind.WORK }],
                notes: "Met at the Analytical Engine demo.",
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Contacts", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Contacts", folder.uid),
            );

            const appData = firstAddAppData(response);
            expect(childText(appData, "FileAs")).toBe("Ada Lovelace");
            expect(childText(appData, "FirstName")).toBe("Ada");
            expect(childText(appData, "LastName")).toBe("Lovelace");
            expect(childText(appData, "CompanyName")).toBe("Analytical Engines Ltd");
            expect(childText(appData, "JobTitle")).toBe("Mathematician");
            expect(childText(appData, "Email1Address")).toBe("ada@example.com");
            expect(childText(appData, "HomePhoneNumber")).toBe("555-1234");
            expect(childText(appData, "BusinessStreet")).toBe("1 Babbage Way");
            expect(childText(appData, "BusinessCity")).toBe("London");
            const body = findChild(appData, "Body")!;
            expect(childText(body, "Data")).toBe("Met at the Analytical Engine demo.");
        });

        it("Reports a minimal contact as an Add, omitting unset optional fields and dropping an OTHER-kind phone.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
            await createContact(mailbox.uid, folder.uid, {
                displayName: "Bare Contact",
                phones: [{ phoneNumber: "555-0000", type: ContactAddressKind.OTHER }],
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Contacts", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Contacts", folder.uid),
            );

            const appData = firstAddAppData(response);
            expect(childText(appData, "FileAs")).toBe("Bare Contact");
            expect(findChild(appData, "FirstName")).toBeUndefined();
            expect(findChild(appData, "LastName")).toBeUndefined();
            expect(findChild(appData, "CompanyName")).toBeUndefined();
            expect(findChild(appData, "JobTitle")).toBeUndefined();
            expect(findChild(appData, "Body")).toBeUndefined();
            expect(findChild(appData, "HomePhoneNumber")).toBeUndefined();
            expect(findChild(appData, "BusinessPhoneNumber")).toBeUndefined();
        });

        it("Reports a minimal calendar event as an Add, omitting attendees/reminder/recurrence.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            await createCalendarEvent(mailbox.uid, folder.uid, {
                title: "Solo Focus Time",
                organizer: { address: "owner@example.com", type: RecipientType.TO },
                busyStatus: BusyStatus.FREE,
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Calendar", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Calendar", folder.uid),
            );

            const appData = firstAddAppData(response);
            expect(childText(appData, "Subject")).toBe("Solo Focus Time");
            expect(findChild(appData, "Location")).toBeUndefined();
            expect(childText(appData, "BusyStatus")).toBe("0");
            expect(childText(appData, "MeetingStatus")).toBe("0");
            expect(findChild(appData, "OrganizerName")).toBeUndefined();
            expect(findChild(appData, "Attendees")).toBeUndefined();
            expect(findChild(appData, "Reminder")).toBeUndefined();
            expect(findChild(appData, "Recurrence")).toBeUndefined();
        });

        it("Reports a yearly-recurring calendar event, deriving DayOfMonth/MonthOfYear from the start date.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            await createCalendarEvent(mailbox.uid, folder.uid, {
                title: "Anniversary",
                organizer: { address: "owner@example.com", type: RecipientType.TO },
                startDate: new Date("2026-03-15T09:00:00.000Z"),
                endDate: new Date("2026-03-15T10:00:00.000Z"),
                recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, exceptions: [] },
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Calendar", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Calendar", folder.uid),
            );

            const recurrence = findChild(firstAddAppData(response), "Recurrence")!;
            expect(childText(recurrence, "Type")).toBe("5");
            expect(childText(recurrence, "DayOfMonth")).toBe("15");
            expect(childText(recurrence, "MonthOfYear")).toBe("3");
            expect(findChild(recurrence, "DayOfWeek")).toBeUndefined();
            expect(findChild(recurrence, "Until")).toBeUndefined();
            expect(findChild(recurrence, "Occurrences")).toBeUndefined();
        });

        it("Reports an all-day event with a bounded recurrence and a nameless attendee.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            await createCalendarEvent(mailbox.uid, folder.uid, {
                title: "Company Holiday",
                allDay: true,
                organizer: { address: "owner@example.com", type: RecipientType.TO },
                attendees: [
                    {
                        address: "attendee@example.com",
                        role: AttendeeRole.OPTIONAL,
                        responseStatus: AttendeeResponseStatus.DECLINED,
                        isOrganizer: false,
                    },
                ],
                recurrenceRule: {
                    freq: RecurrenceFrequency.MONTHLY,
                    interval: 1,
                    byMonthDay: [1],
                    until: new Date("2026-12-31T00:00:00.000Z"),
                    count: 12,
                    exceptions: [],
                },
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Calendar", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Calendar", folder.uid),
            );

            const appData = firstAddAppData(response);
            expect(childText(appData, "AllDayEvent")).toBe("1");
            const attendee = findChild(findChild(appData, "Attendees")!, "Attendee")!;
            expect(findChild(attendee, "Name")).toBeUndefined();
            expect(childText(attendee, "AttendeeType")).toBe("2");
            expect(childText(attendee, "AttendeeStatus")).toBe("4");
            const recurrence = findChild(appData, "Recurrence")!;
            expect(childText(recurrence, "Type")).toBe("2");
            expect(childText(recurrence, "DayOfMonth")).toBe("1");
            expect(childText(recurrence, "Until")).toBe("20261231T000000Z");
            expect(childText(recurrence, "Occurrences")).toBe("12");
        });

        it("Reports an existing calendar event as an Add, mapping attendees and a weekly recurrence.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            await createCalendarEvent(mailbox.uid, folder.uid, {
                title: "Team Sync",
                location: "Room 42",
                organizer: { address: "owner@example.com", displayName: "Owner", type: RecipientType.TO },
                attendees: [
                    {
                        address: "attendee@example.com",
                        displayName: "Attendee",
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.ACCEPTED,
                        isOrganizer: false,
                    },
                ],
                busyStatus: BusyStatus.BUSY,
                reminderMinutesBeforeStart: 15,
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, byDay: ["MO", "WE"], exceptions: [] },
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Calendar", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Calendar", folder.uid),
            );

            const appData = firstAddAppData(response);
            expect(childText(appData, "Subject")).toBe("Team Sync");
            expect(childText(appData, "Location")).toBe("Room 42");
            expect(childText(appData, "BusyStatus")).toBe("2");
            expect(childText(appData, "MeetingStatus")).toBe("1");
            expect(childText(appData, "OrganizerEmail")).toBe("owner@example.com");
            expect(childText(appData, "Reminder")).toBe("15");
            const attendee = findChild(findChild(appData, "Attendees")!, "Attendee")!;
            expect(childText(attendee, "Email")).toBe("attendee@example.com");
            expect(childText(attendee, "AttendeeType")).toBe("1");
            expect(childText(attendee, "AttendeeStatus")).toBe("3");
            const recurrence = findChild(appData, "Recurrence")!;
            expect(childText(recurrence, "Type")).toBe("1");
            expect(childText(recurrence, "DayOfWeek")).toBe(String(2 | 8));
        });

        it("Reports an existing task as an Add, mapping due date, reminder, and body.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Tasks", type: FolderType.TASKS });
            await createTask(mailbox.uid, folder.uid, {
                title: "Finish the report",
                body: "Quarterly numbers.",
                dueDate: new Date("2026-02-01T00:00:00.000Z"),
                reminderDate: new Date("2026-01-31T09:00:00.000Z"),
                priority: TaskPriority.HIGH,
                completed: false,
            });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Tasks", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Tasks", folder.uid),
            );

            const appData = firstAddAppData(response);
            expect(childText(appData, "Subject")).toBe("Finish the report");
            expect(childText(appData, "Complete")).toBe("0");
            expect(childText(appData, "Importance")).toBe("2");
            expect(childText(appData, "UtcDueDate")).toBe("20260201T000000Z");
            expect(childText(appData, "ReminderSet")).toBe("1");
            expect(childText(appData, "ReminderTime")).toBe("20260131T090000Z");
            const body = findChild(appData, "Body")!;
            expect(childText(body, "Data")).toBe("Quarterly numbers.");
        });

        it("Reports a completed task with no due date/reminder/body as an Add.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Tasks", type: FolderType.TASKS });
            await createTask(mailbox.uid, folder.uid, { title: "Already done", completed: true });

            const initial = await postWbxml("Sync", "dev1", syncRequest("0", "Tasks", folder.uid));
            const response = await postWbxml(
                "Sync",
                "dev1",
                syncRequest(childText(findChild(findChild(initial, "Collections")!, "Collection")!, "SyncKey")!, "Tasks", folder.uid),
            );

            const appData = firstAddAppData(response);
            expect(childText(appData, "Complete")).toBe("1");
            expect(findChild(appData, "DateCompleted")).not.toBeUndefined();
            expect(findChild(appData, "UtcDueDate")).toBeUndefined();
            expect(childText(appData, "ReminderSet")).toBe("0");
            expect(findChild(appData, "ReminderTime")).toBeUndefined();
            expect(findChild(appData, "Body")).toBeUndefined();
        });

        const collectionOf = function (response: WbxmlElement): WbxmlElement {
            return findChild(findChild(response, "Collections")!, "Collection")!;
        };

        const syncRequestWithCommands = function (
            syncKey: string,
            collectionClass: string,
            folderUid: string,
            commandsChildren: WbxmlElement[],
        ): WbxmlElement {
            return element(WbxmlCodePage.AirSync, "Sync", [
                element(WbxmlCodePage.AirSync, "Collections", [
                    element(WbxmlCodePage.AirSync, "Collection", [
                        textElement(WbxmlCodePage.AirSync, "Class", collectionClass),
                        textElement(WbxmlCodePage.AirSync, "SyncKey", syncKey),
                        textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid),
                        element(WbxmlCodePage.AirSync, "Commands", commandsChildren),
                    ]),
                ]),
            ]);
        };

        /** See the identical helper in test/routes/mongo/EasRoute.test.ts. */
        const initialSyncKey = async function (collectionClass: string, folderUid: string): Promise<string> {
            const initial = await postWbxml("Sync", "dev1", syncRequest("0", collectionClass, folderUid));
            return childText(collectionOf(initial), "SyncKey")!;
        };

        describe("Client-originated Add/Change/Delete", () => {
            it("Creates a contact via a client-originated Add, reporting Status 1 with the assigned ServerId.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
                const syncKey = await initialSyncKey("Contacts", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Contacts", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Add", [
                            textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                            element(WbxmlCodePage.AirSync, "ApplicationData", [
                                textElement(WbxmlCodePage.Contacts, "FileAs", "New Contact"),
                                textElement(WbxmlCodePage.Contacts, "Email1Address", "new@example.com"),
                            ]),
                        ]),
                    ]),
                );

                const add = findChild(findChild(collectionOf(response), "Responses")!, "Add")!;
                expect(childText(add, "ClientId")).toBe("client-1");
                expect(childText(add, "Status")).toBe("1");
                const serverId = childText(add, "ServerId")!;
                expect(serverId).toBeTruthy();

                const created = await contactRepo.findOne({ where: { uid: serverId } });
                expect(created?.displayName).toBe("New Contact");
                expect(created?.emails).toEqual([{ address: "new@example.com", type: ContactAddressKind.OTHER }]);
                expect(created?.mailboxUid).toBe(mailbox.uid);
                expect(created?.folderUid).toBe(folder.uid);
            });

            it("Creates a calendar event via a client-originated Add, assigning a unique icalUid and sequence 0.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
                const syncKey = await initialSyncKey("Calendar", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Calendar", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Add", [
                            textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                            element(WbxmlCodePage.AirSync, "ApplicationData", [
                                textElement(WbxmlCodePage.Calendar, "Subject", "New Meeting"),
                                textElement(WbxmlCodePage.Calendar, "StartTime", "20260301T090000Z"),
                                textElement(WbxmlCodePage.Calendar, "EndTime", "20260301T093000Z"),
                                textElement(WbxmlCodePage.Calendar, "OrganizerEmail", "owner@example.com"),
                            ]),
                        ]),
                    ]),
                );

                const add = findChild(findChild(collectionOf(response), "Responses")!, "Add")!;
                expect(childText(add, "Status")).toBe("1");
                const serverId = childText(add, "ServerId")!;

                const created = await calendarEventRepo.findOne({ where: { uid: serverId } });
                expect(created?.title).toBe("New Meeting");
                expect(created?.sequence).toBe(0);
                expect(created?.icalUid).toMatch(/^[0-9a-f-]{36}@eas$/);
            });

            it("Rejects a client-originated Calendar Add with Status 6 when a required field is malformed.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
                const syncKey = await initialSyncKey("Calendar", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Calendar", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Add", [
                            textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                            element(WbxmlCodePage.AirSync, "ApplicationData", [
                                textElement(WbxmlCodePage.Calendar, "Subject", "Bad Event"),
                                textElement(WbxmlCodePage.Calendar, "BusyStatus", "99"),
                            ]),
                        ]),
                    ]),
                );

                const add = findChild(findChild(collectionOf(response), "Responses")!, "Add")!;
                expect(childText(add, "ClientId")).toBe("client-1");
                expect(childText(add, "Status")).toBe("6");
                expect(findChild(add, "ServerId")).toBeUndefined();
            });

            it("Creates a task via a client-originated Add.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Tasks", type: FolderType.TASKS });
                const syncKey = await initialSyncKey("Tasks", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Tasks", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Add", [
                            textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                            element(WbxmlCodePage.AirSync, "ApplicationData", [
                                textElement(WbxmlCodePage.Tasks, "Subject", "New Task"),
                                textElement(WbxmlCodePage.Tasks, "Importance", "2"),
                            ]),
                        ]),
                    ]),
                );

                const add = findChild(findChild(collectionOf(response), "Responses")!, "Add")!;
                expect(childText(add, "Status")).toBe("1");
                const created = await taskRepo.findOne({ where: { uid: childText(add, "ServerId")! } });
                expect(created?.title).toBe("New Task");
                expect(created?.priority).toBe(TaskPriority.HIGH);
            });

            it("Rejects a client-originated Email Add with Status 6, per [MS-ASCMD]'s own non-draft-email rule.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
                const syncKey = await initialSyncKey("Email", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Email", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Add", [
                            textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                            element(WbxmlCodePage.AirSync, "ApplicationData", []),
                        ]),
                    ]),
                );

                const add = findChild(findChild(collectionOf(response), "Responses")!, "Add")!;
                expect(childText(add, "ClientId")).toBe("client-1");
                expect(childText(add, "Status")).toBe("6");
            });

            it("Updates a contact via a client-originated Change silently (no Responses entry), and persists it.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
                const contact = await createContact(mailbox.uid, folder.uid, { displayName: "Original Name" });
                const syncKey = await initialSyncKey("Contacts", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Contacts", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Change", [
                            textElement(WbxmlCodePage.AirSync, "ServerId", contact.uid),
                            element(WbxmlCodePage.AirSync, "ApplicationData", [
                                textElement(WbxmlCodePage.Contacts, "FileAs", "Renamed Contact"),
                            ]),
                        ]),
                    ]),
                );

                expect(findChild(collectionOf(response), "Responses")).toBeUndefined();
                const updated = await contactRepo.findOne({ where: { uid: contact.uid } });
                expect(updated?.displayName).toBe("Renamed Contact");
            });

            it("Reports Status 8 when a Change targets a ServerId that doesn't exist.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
                const syncKey = await initialSyncKey("Contacts", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Contacts", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Change", [
                            textElement(WbxmlCodePage.AirSync, "ServerId", "does-not-exist"),
                            element(WbxmlCodePage.AirSync, "ApplicationData", [
                                textElement(WbxmlCodePage.Contacts, "FileAs", "Doesn't matter"),
                            ]),
                        ]),
                    ]),
                );

                const change = findChild(findChild(collectionOf(response), "Responses")!, "Change")!;
                expect(childText(change, "ServerId")).toBe("does-not-exist");
                expect(childText(change, "Status")).toBe("8");
            });

            it("Deletes a contact via a client-originated Delete silently (no Responses entry), soft-deleting it.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
                const contact = await createContact(mailbox.uid, folder.uid);
                const syncKey = await initialSyncKey("Contacts", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Contacts", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", contact.uid)]),
                    ]),
                );

                expect(findChild(collectionOf(response), "Responses")).toBeUndefined();
                const deleted = await contactRepo.findOne({ where: { uid: contact.uid } });
                // See the identical assertion's own comment in test/routes/mongo/EasRoute.test.ts.
                expect(deleted?.deleted).toBe(true);
            });

            it("Reports Status 8 when a Delete targets a ServerId that doesn't exist.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
                const syncKey = await initialSyncKey("Contacts", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Contacts", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "does-not-exist")]),
                    ]),
                );

                const del = findChild(findChild(collectionOf(response), "Responses")!, "Delete")!;
                expect(childText(del, "ServerId")).toBe("does-not-exist");
                expect(childText(del, "Status")).toBe("8");
            });

            it("Accepts a client-originated Email Delete silently, soft-deleting the message.", async () => {
                const mailbox = await createMailbox(owner.uid);
                await provisionDevice("dev1");
                const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
                const message = await createMessage(mailbox.uid, folder.uid);
                const syncKey = await initialSyncKey("Email", folder.uid);

                const response = await postWbxml(
                    "Sync",
                    "dev1",
                    syncRequestWithCommands(syncKey, "Email", folder.uid, [
                        element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", message.uid)]),
                    ]),
                );

                expect(findChild(collectionOf(response), "Responses")).toBeUndefined();
                const deleted = await messageRepo.findOne({ where: { uid: message.uid } });
                expect(deleted?.deleted).toBe(true);
            });
        });
    });

    describe("SendMail/SmartForward/SmartReply commands", () => {
        const rawMime = function (
            overrides: { from?: string; to?: string; cc?: string; bcc?: string; subject?: string; body?: string } = {},
        ): Buffer {
            const lines = [
                `From: ${overrides.from ?? "owner@example.com"}`,
                `To: ${overrides.to ?? "recipient@example.com"}`,
                ...(overrides.cc ? [`Cc: ${overrides.cc}`] : []),
                ...(overrides.bcc ? [`Bcc: ${overrides.bcc}`] : []),
                `Subject: ${overrides.subject ?? "Test Compose"}`,
                "MIME-Version: 1.0",
                "Content-Type: text/plain; charset=utf-8",
                "",
                overrides.body ?? "Hello from EAS.",
                "",
            ];
            return Buffer.from(lines.join("\r\n"));
        };

        const composeRequest = function (
            cmd: "SendMail" | "SmartForward" | "SmartReply",
            mime: Buffer,
            opts: { saveInSentItems?: boolean; source?: { folderUid: string; itemId: string } } = {},
        ): WbxmlElement {
            return element(WbxmlCodePage.ComposeMail, cmd, [
                textElement(WbxmlCodePage.ComposeMail, "ClientId", uuid.v4()),
                ...(opts.saveInSentItems ? [element(WbxmlCodePage.ComposeMail, "SaveInSentItems", [])] : []),
                ...(opts.source
                    ? [
                          element(WbxmlCodePage.ComposeMail, "Source", [
                              textElement(WbxmlCodePage.ComposeMail, "FolderId", opts.source.folderUid),
                              textElement(WbxmlCodePage.ComposeMail, "ItemId", opts.source.itemId),
                          ]),
                      ]
                    : []),
                opaqueElement(WbxmlCodePage.ComposeMail, "MIME", mime),
            ]);
        };

        const transport = function (): RecordingMailTransport {
            return objectFactory.getInstance<RecordingMailTransport>("MailTransport")!;
        };

        it("SendMail relays the composed message and returns an empty response.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(composeRequest("SendMail", rawMime())));

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(result.body.length).toBe(0);
            expect(transport().sent.length).toBe(1);
            expect(transport().sent[0].envelopeTo).toEqual(["recipient@example.com"]);
        });

        it("SendMail with SaveInSentItems creates a Message in the mailbox's Sent Items folder.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const mime = rawMime({ subject: "Saved Copy", cc: "cc@example.com", bcc: "bcc@example.com" });
            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(composeRequest("SendMail", mime, { saveInSentItems: true })));
            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);

            const sentFolder = await folderRepo.findOne({ where: { type: FolderType.SENT_ITEMS } });
            expect(sentFolder).not.toBeNull();
            const saved = await messageRepo.findOne({ where: { folderUid: sentFolder!.uid, subject: "Saved Copy" } });
            expect(saved).not.toBeNull();
            expect(saved?.from.address).toBe("owner@example.com");
            expect(saved?.recipients).toEqual([
                { address: "recipient@example.com", type: RecipientType.TO },
                { address: "cc@example.com", type: RecipientType.CC },
                { address: "bcc@example.com", type: RecipientType.BCC },
            ]);
            expect(saved?.flags.read).toBe(true);
        });

        it("SendMail without SaveInSentItems relays but does not save a copy.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(composeRequest("SendMail", rawMime())));

            expect(transport().sent.length).toBe(1);
            const anyMessage = await messageRepo.findOne({ where: {} });
            expect(anyMessage).toBeNull();
        });

        it("Rejects a compose request with no MIME body.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.ComposeMail, "SendMail", [
                            textElement(WbxmlCodePage.ComposeMail, "ClientId", uuid.v4()),
                        ]),
                    ),
                );

            expect(result.status).toBe(400);
        });

        it("Returns 422 when the composed message fails spam scanning.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(composeRequest("SendMail", rawMime({ body: "X-Test-Force-Spam: true" }))));

            expect(result.status).toBe(422);
            expect(transport().sent.length).toBe(0);
        });

        it("Returns 502 when the mail transport rejects the message.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(composeRequest("SendMail", rawMime({ to: "reject@example.com" }))));

            expect(result.status).toBe(502);
        });

        it("SmartReply threads the reply to the original and marks it Answered.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const inbox = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const original = await createMessage(mailbox.uid, inbox.uid, {
                messageId: "<original@example.com>",
                references: ["<earlier@example.com>"],
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SmartReply&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        composeRequest("SmartReply", rawMime({ subject: "Re: Test Compose" }), {
                            saveInSentItems: true,
                            source: { folderUid: inbox.uid, itemId: original.uid },
                        }),
                    ),
                );
            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);

            const updatedOriginal = await messageRepo.findOne({ where: { uid: original.uid } });
            expect(updatedOriginal?.flags.answered).toBe(true);
            expect(updatedOriginal?.flags.forwarded).toBe(false);

            const reply = await messageRepo.findOne({ where: { subject: "Re: Test Compose" } });
            expect(reply?.inReplyTo).toBe("<original@example.com>");
            expect(reply?.references).toEqual(["<earlier@example.com>", "<original@example.com>"]);
        });

        it("SmartForward marks the original message Forwarded.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const inbox = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const original = await createMessage(mailbox.uid, inbox.uid, { messageId: "<original2@example.com>" });

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SmartForward&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        composeRequest("SmartForward", rawMime({ subject: "Fwd: Test Compose" }), {
                            source: { folderUid: inbox.uid, itemId: original.uid },
                        }),
                    ),
                );
            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);

            const updatedOriginal = await messageRepo.findOne({ where: { uid: original.uid } });
            expect(updatedOriginal?.flags.forwarded).toBe(true);
            expect(updatedOriginal?.flags.answered).toBe(false);
        });

        it("Returns 404 when Source.ItemId references a message that doesn't exist.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SmartReply&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        composeRequest("SmartReply", rawMime(), {
                            source: { folderUid: "nonexistent-folder", itemId: uuid.v4() },
                        }),
                    ),
                );

            expect(result.status).toBe(404);
        });

        it("Returns 403 when Source.ItemId references a message the caller has no permission on.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const otherMailbox = await createMailbox(otherUser.uid);
            const otherInbox = await createFolderWithAcl(otherMailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const otherMessage = await createMessage(otherMailbox.uid, otherInbox.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SmartReply&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        composeRequest("SmartReply", rawMime(), {
                            source: { folderUid: otherInbox.uid, itemId: otherMessage.uid },
                        }),
                    ),
                );

            expect(result.status).toBe(403);
        });

        it("Returns 400 when Source is present but missing its required ItemId.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SmartReply&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.ComposeMail, "SmartReply", [
                            element(WbxmlCodePage.ComposeMail, "Source", [
                                textElement(WbxmlCodePage.ComposeMail, "FolderId", "some-folder"),
                            ]),
                            opaqueElement(WbxmlCodePage.ComposeMail, "MIME", rawMime()),
                        ]),
                    ),
                );

            expect(result.status).toBe(400);
        });

        it("Returns 400 when the composed Mime has no resolvable From/To address.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const noAddressMime = Buffer.from(["Subject: No addresses", "MIME-Version: 1.0", "Content-Type: text/plain", "", "Body only."].join("\r\n"));

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(composeRequest("SendMail", noAddressMime)));

            expect(result.status).toBe(400);
        });

        it("SendMail with SaveInSentItems flattens a grouped (mailing-list-style) To header.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const groupedMime = Buffer.from(
                [
                    "From: owner@example.com",
                    "To: Team:alice@example.com,bob@example.com;",
                    "Subject: Grouped Recipients",
                    "MIME-Version: 1.0",
                    "Content-Type: text/plain; charset=utf-8",
                    "",
                    "Hello team.",
                    "",
                ].join("\r\n"),
            );

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(composeRequest("SendMail", groupedMime, { saveInSentItems: true })));

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            expect(transport().sent[0].envelopeTo.sort()).toEqual(["alice@example.com", "bob@example.com"]);
            const saved = await messageRepo.findOne({ where: { subject: "Grouped Recipients" } });
            expect(saved?.recipients.map((r) => r.address).sort()).toEqual(["alice@example.com", "bob@example.com"]);
        });

        it("SendMail with a Source (non-standard, but not rejected) relays without touching any original message.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const inbox = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const original = await createMessage(mailbox.uid, inbox.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=SendMail&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        composeRequest("SendMail", rawMime(), { source: { folderUid: inbox.uid, itemId: original.uid } }),
                    ),
                );

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
            const unchanged = await messageRepo.findOne({ where: { uid: original.uid } });
            expect(unchanged?.flags.answered).toBe(false);
            expect(unchanged?.flags.forwarded).toBe(false);
        });
    });

    describe("ItemOperations command", () => {
        it("Fetches a message's plain-text body from raw MIME when no sanitized HTML is available.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const message = await createMessage(mailbox.uid, folder.uid, { sanitizedHtmlBlobKey: undefined });
            await blobStore().put(
                message.bodyBlobKey,
                Buffer.from("From: sender@example.com\r\nTo: owner@example.com\r\nSubject: Hi\r\n\r\nPlain body text."),
                { contentType: "message/rfc822" },
            );

            const response = await postWbxml(
                "ItemOperations",
                "dev1",
                element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                    element(WbxmlCodePage.ItemOperations, "Fetch", [
                        textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                        textElement(WbxmlCodePage.AirSync, "CollectionId", folder.uid),
                        textElement(WbxmlCodePage.AirSync, "ServerId", message.uid),
                    ]),
                ]),
            );

            expect(childText(response, "Status")).toBe("1");
            const fetch = findChild(findChild(response, "Response")!, "Fetch")!;
            expect(childText(fetch, "Status")).toBe("1");
            expect(childText(fetch, "ServerId")).toBe(message.uid);
            const body = findChild(findChild(fetch, "Properties")!, "Body")!;
            expect(childText(body, "Type")).toBe("1");
            expect(childText(body, "Data")).toBe("Plain body text.");
        });

        it("Fetches a message's sanitized HTML body when available.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const sanitizedHtmlBlobKey = `sanitized/${uuid.v4()}`;
            await blobStore().put(sanitizedHtmlBlobKey, Buffer.from("<p>Hello HTML</p>"), { contentType: "text/html" });
            const message = await createMessage(mailbox.uid, folder.uid, { sanitizedHtmlBlobKey });

            const response = await postWbxml(
                "ItemOperations",
                "dev1",
                element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                    element(WbxmlCodePage.ItemOperations, "Fetch", [
                        textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                        textElement(WbxmlCodePage.AirSync, "ServerId", message.uid),
                    ]),
                ]),
            );

            const fetch = findChild(findChild(response, "Response")!, "Fetch")!;
            const body = findChild(findChild(fetch, "Properties")!, "Body")!;
            expect(childText(body, "Type")).toBe("2");
            expect(childText(body, "Data")).toBe("<p>Hello HTML</p>");
        });

        it("Fetches an attachment's content by FileReference, base64-encoded inline.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const message = await createMessage(mailbox.uid, folder.uid);
            const attachment = await createAttachment(message.uid, folder.uid, mailbox.uid, Buffer.from("attachment bytes"), {
                mimeType: "application/pdf",
            });

            const response = await postWbxml(
                "ItemOperations",
                "dev1",
                element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                    element(WbxmlCodePage.ItemOperations, "Fetch", [
                        textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                        textElement(WbxmlCodePage.AirSyncBase, "FileReference", attachment.uid),
                    ]),
                ]),
            );

            const fetch = findChild(findChild(response, "Response")!, "Fetch")!;
            expect(childText(fetch, "FileReference")).toBe(attachment.uid);
            const properties = findChild(fetch, "Properties")!;
            expect(childText(properties, "ContentType")).toBe("application/pdf");
            expect(childText(properties, "Data")).toBe(Buffer.from("attachment bytes").toString("base64"));
        });

        it("Returns 404 when the referenced ServerId doesn't exist.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=ItemOperations&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                            element(WbxmlCodePage.ItemOperations, "Fetch", [
                                textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                                textElement(WbxmlCodePage.AirSync, "ServerId", uuid.v4()),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(404);
        });

        it("Returns 403 when fetching a message the caller has no permission on.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const otherMailbox = await createMailbox(otherUser.uid);
            const otherInbox = await createFolderWithAcl(otherMailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const otherMessage = await createMessage(otherMailbox.uid, otherInbox.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=ItemOperations&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                            element(WbxmlCodePage.ItemOperations, "Fetch", [
                                textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                                textElement(WbxmlCodePage.AirSync, "ServerId", otherMessage.uid),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(403);
        });

        it("Returns 400 when a Fetch has neither ServerId nor FileReference.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=ItemOperations&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                            element(WbxmlCodePage.ItemOperations, "Fetch", [
                                textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(400);
        });

        it("Returns 400 when the request has no Fetch element at all.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=ItemOperations&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(element(WbxmlCodePage.ItemOperations, "ItemOperations", [])));

            expect(result.status).toBe(400);
        });

        it("Returns 400 when the request has no WBXML body at all.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=ItemOperations&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(400);
        });

        it("Returns 404 when the referenced FileReference doesn't exist.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=ItemOperations&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                            element(WbxmlCodePage.ItemOperations, "Fetch", [
                                textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                                textElement(WbxmlCodePage.AirSyncBase, "FileReference", uuid.v4()),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(404);
        });

        it("Returns 403 when fetching an attachment the caller has no permission on.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const otherMailbox = await createMailbox(otherUser.uid);
            const otherInbox = await createFolderWithAcl(otherMailbox.uid, { name: "Inbox", type: FolderType.INBOX });
            const otherMessage = await createMessage(otherMailbox.uid, otherInbox.uid);
            const otherAttachment = await createAttachment(otherMessage.uid, otherInbox.uid, otherMailbox.uid, Buffer.from("secret"));

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=ItemOperations&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                            element(WbxmlCodePage.ItemOperations, "Fetch", [
                                textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                                textElement(WbxmlCodePage.AirSyncBase, "FileReference", otherAttachment.uid),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(403);
        });
    });

    describe("Search command", () => {
        const searchRequest = function (query: string, range?: string): WbxmlElement {
            return element(WbxmlCodePage.Search, "Search", [
                element(WbxmlCodePage.Search, "Store", [
                    textElement(WbxmlCodePage.Search, "Name", "GAL"),
                    textElement(WbxmlCodePage.Search, "Query", query),
                    ...(range
                        ? [element(WbxmlCodePage.Search, "Options", [textElement(WbxmlCodePage.Search, "Range", range)])]
                        : []),
                ]),
            ]);
        };

        it("Finds a GAL contact by a case-insensitive substring of its display name.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
            await createContact(mailbox.uid, folder.uid, {
                displayName: "Grace Hopper",
                givenName: "Grace",
                surname: "Hopper",
                company: "US Navy",
                jobTitle: "Rear Admiral",
                emails: [{ address: "grace@example.com", type: ContactAddressKind.WORK }],
                phones: [{ phoneNumber: "555-9999", type: ContactAddressKind.WORK }],
            });

            const response = await postWbxml("Search", "dev1", searchRequest("hopper"));

            const store = findChild(findChild(response, "Response")!, "Store")!;
            expect(childText(store, "Status")).toBe("1");
            expect(childText(store, "Total")).toBe("1");
            const properties = findChild(findChild(store, "Result")!, "Properties")!;
            expect(childText(properties, "DisplayName")).toBe("Grace Hopper");
            expect(childText(properties, "FirstName")).toBe("Grace");
            expect(childText(properties, "LastName")).toBe("Hopper");
            expect(childText(properties, "Company")).toBe("US Navy");
            expect(childText(properties, "Title")).toBe("Rear Admiral");
            expect(childText(properties, "EmailAddress")).toBe("grace@example.com");
            expect(childText(properties, "Phone")).toBe("555-9999");
        });

        it("Returns Total 0 with no Result elements when nothing matches.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const response = await postWbxml("Search", "dev1", searchRequest("nobody-matches-this"));

            const store = findChild(findChild(response, "Response")!, "Store")!;
            expect(childText(store, "Total")).toBe("0");
            expect(findChild(store, "Result")).toBeUndefined();
        });

        it("Honors a Range to page results, while Total still reflects the full match count.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Contacts", type: FolderType.CONTACTS });
            await createContact(mailbox.uid, folder.uid, { displayName: "Ann Alpha" });
            await createContact(mailbox.uid, folder.uid, { displayName: "Ann Beta" });

            const response = await postWbxml("Search", "dev1", searchRequest("Ann", "0-0"));

            const store = findChild(findChild(response, "Response")!, "Store")!;
            expect(childText(store, "Total")).toBe("2");
            expect(findChildren(store, "Result").length).toBe(1);
        });

        it("Returns 400 when the Store name isn't GAL.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=Search&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.Search, "Search", [
                            element(WbxmlCodePage.Search, "Store", [
                                textElement(WbxmlCodePage.Search, "Name", "Mailbox"),
                                textElement(WbxmlCodePage.Search, "Query", "test"),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(400);
        });
    });

    describe("MeetingResponse command", () => {
        it("Accepts a meeting, updating the caller's own Attendee and returning a CalendarId.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            const event = await createCalendarEvent(mailbox.uid, folder.uid, {
                attendees: [
                    {
                        address: mailbox.primarySmtpAddress,
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                ],
            });

            const response = await postWbxml(
                "MeetingResponse",
                "dev1",
                element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
                    element(WbxmlCodePage.MeetingResponse, "Request", [
                        textElement(WbxmlCodePage.MeetingResponse, "UserResponse", "1"),
                        textElement(WbxmlCodePage.MeetingResponse, "CollectionId", folder.uid),
                        textElement(WbxmlCodePage.MeetingResponse, "RequestId", event.uid),
                    ]),
                ]),
            );

            const result = findChild(response, "Result")!;
            expect(childText(result, "Status")).toBe("1");
            expect(childText(result, "CalendarId")).toBe(event.uid);

            const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
            expect(updated?.attendees[0].responseStatus).toBe(AttendeeResponseStatus.ACCEPTED);
        });

        it("Declines a meeting, updating the Attendee but omitting CalendarId from the response.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            const event = await createCalendarEvent(mailbox.uid, folder.uid, {
                attendees: [
                    {
                        address: mailbox.primarySmtpAddress,
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                ],
            });

            const response = await postWbxml(
                "MeetingResponse",
                "dev1",
                element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
                    element(WbxmlCodePage.MeetingResponse, "Request", [
                        textElement(WbxmlCodePage.MeetingResponse, "UserResponse", "3"),
                        textElement(WbxmlCodePage.MeetingResponse, "CollectionId", folder.uid),
                        textElement(WbxmlCodePage.MeetingResponse, "RequestId", event.uid),
                    ]),
                ]),
            );

            const result = findChild(response, "Result")!;
            expect(childText(result, "Status")).toBe("1");
            expect(findChild(result, "CalendarId")).toBeUndefined();

            const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
            expect(updated?.attendees[0].responseStatus).toBe(AttendeeResponseStatus.DECLINED);
        });

        it("Returns 404 when RequestId references a calendar event that doesn't exist.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=MeetingResponse&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
                            element(WbxmlCodePage.MeetingResponse, "Request", [
                                textElement(WbxmlCodePage.MeetingResponse, "UserResponse", "1"),
                                textElement(WbxmlCodePage.MeetingResponse, "CollectionId", "some-folder"),
                                textElement(WbxmlCodePage.MeetingResponse, "RequestId", uuid.v4()),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(404);
        });

        it("Returns 404 when the caller is not an attendee of the referenced event.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            const event = await createCalendarEvent(mailbox.uid, folder.uid, {
                attendees: [
                    {
                        address: "someone-else@example.com",
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                ],
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=MeetingResponse&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
                            element(WbxmlCodePage.MeetingResponse, "Request", [
                                textElement(WbxmlCodePage.MeetingResponse, "UserResponse", "1"),
                                textElement(WbxmlCodePage.MeetingResponse, "CollectionId", folder.uid),
                                textElement(WbxmlCodePage.MeetingResponse, "RequestId", event.uid),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(404);
        });

        it("Returns 400 when the Request is missing UserResponse.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            const event = await createCalendarEvent(mailbox.uid, folder.uid);

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=MeetingResponse&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
                            element(WbxmlCodePage.MeetingResponse, "Request", [
                                textElement(WbxmlCodePage.MeetingResponse, "CollectionId", folder.uid),
                                textElement(WbxmlCodePage.MeetingResponse, "RequestId", event.uid),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(400);
        });

        it("Returns 400 when the request has no Request element at all.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=MeetingResponse&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(new WbxmlEncoder().encode(element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [])));

            expect(result.status).toBe(400);
        });

        it("Returns 400 when the request has no WBXML body at all.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=MeetingResponse&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken);

            expect(result.status).toBe(400);
        });

        it("Only updates the matching Attendee, leaving co-attendees untouched, and matches by alias address.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { aliasAddresses: ["alias@example.com"] });
            await provisionDevice("dev1");
            const folder = await createFolderWithAcl(mailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            const event = await createCalendarEvent(mailbox.uid, folder.uid, {
                attendees: [
                    {
                        address: "someone-else@example.com",
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                    {
                        // Matches via the mailbox's alias, not its primary address.
                        address: "alias@example.com",
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                ],
            });

            await postWbxml(
                "MeetingResponse",
                "dev1",
                element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
                    element(WbxmlCodePage.MeetingResponse, "Request", [
                        textElement(WbxmlCodePage.MeetingResponse, "UserResponse", "2"),
                        textElement(WbxmlCodePage.MeetingResponse, "CollectionId", folder.uid),
                        textElement(WbxmlCodePage.MeetingResponse, "RequestId", event.uid),
                    ]),
                ]),
            );

            const updated = await calendarEventRepo.findOne({ where: { uid: event.uid } });
            expect(updated?.attendees[0].responseStatus).toBe(AttendeeResponseStatus.NEEDS_ACTION);
            expect(updated?.attendees[1].responseStatus).toBe(AttendeeResponseStatus.TENTATIVE);
        });

        it("Returns 403 when responding to a meeting the caller has no permission on.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");
            const otherMailbox = await createMailbox(otherUser.uid);
            const otherCalendar = await createFolderWithAcl(otherMailbox.uid, { name: "Calendar", type: FolderType.CALENDAR });
            const otherEvent = await createCalendarEvent(otherMailbox.uid, otherCalendar.uid, {
                attendees: [
                    {
                        address: otherMailbox.primarySmtpAddress,
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                ],
            });

            const result = await request(server.getApplication())
                .post(`${baseUrl}?Cmd=MeetingResponse&DeviceId=dev1`)
                .set("Authorization", "jwt " + ownerToken)
                .set("Content-Type", "application/vnd.ms-sync.wbxml")
                .send(
                    new WbxmlEncoder().encode(
                        element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
                            element(WbxmlCodePage.MeetingResponse, "Request", [
                                textElement(WbxmlCodePage.MeetingResponse, "UserResponse", "1"),
                                textElement(WbxmlCodePage.MeetingResponse, "CollectionId", otherCalendar.uid),
                                textElement(WbxmlCodePage.MeetingResponse, "RequestId", otherEvent.uid),
                            ]),
                        ]),
                    ),
                );

            expect(result.status).toBe(403);
        });
    });

    describe("Settings command", () => {
        it("UserInformation/Get returns the mailbox's primary and alias SMTP addresses.", async () => {
            const mailbox = await createMailbox(owner.uid);
            await mailboxRepo.update({ uid: mailbox.uid }, { aliasAddresses: ["alias@example.com"] });
            await provisionDevice("dev1");

            const response = await postWbxml(
                "Settings",
                "dev1",
                element(WbxmlCodePage.Settings, "Settings", [
                    element(WbxmlCodePage.Settings, "UserInformation", [element(WbxmlCodePage.Settings, "Get", [])]),
                ]),
            );

            expect(childText(response, "Status")).toBe("1");
            const userInfo = findChild(response, "UserInformation")!;
            expect(childText(userInfo, "Status")).toBe("1");
            const addresses = findChildren(findChild(userInfo, "EmailAddresses")!, "SmtpAddress").map((e) => e.text);
            expect(addresses).toEqual([mailbox.primarySmtpAddress, "alias@example.com"]);
        });

        it("DeviceInformation/Set is acknowledged without requiring UserInformation.", async () => {
            await createMailbox(owner.uid);
            await provisionDevice("dev1");

            const response = await postWbxml(
                "Settings",
                "dev1",
                element(WbxmlCodePage.Settings, "Settings", [
                    element(WbxmlCodePage.Settings, "DeviceInformation", [
                        element(WbxmlCodePage.Settings, "Set", [
                            textElement(WbxmlCodePage.Settings, "Model", "TestPhone"),
                        ]),
                    ]),
                ]),
            );

            expect(childText(response, "Status")).toBe("1");
            const deviceInfo = findChild(response, "DeviceInformation")!;
            expect(childText(deviceInfo, "Status")).toBe("1");
            expect(findChild(response, "UserInformation")).toBeUndefined();
        });
    });
});
