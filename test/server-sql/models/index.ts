// Re-exports just the library's SQL model classes EAS needs so the test Server's ClassLoader (rooted at
// `test/server-sql`) can discover their `@DataStore` metadata alongside the test routes that use them.
// Deliberately a NAMED (not wildcard) re-export - see the identical rationale in
// test/server-mongo/models/index.ts.
export {
    AttachmentSQL,
    CalendarEventSQL,
    ContactSQL,
    DeviceSyncStateSQL,
    FolderSQL,
    MailboxSQL,
    MessageSQL,
    TaskSQL,
} from "@rapidmx/restapi/sql";
