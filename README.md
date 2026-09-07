# RapidMX: ActiveSync

[![CI](https://github.com/RapidMX/activesync/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/RapidMX/activesync/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/RapidMX/activesync/badge.svg?branch=main)](https://coveralls.io/github/RapidMX/activesync?branch=main)
[![npm version](https://img.shields.io/npm/v/@rapidmx/activesync)](https://www.npmjs.com/package/@rapidmx/activesync)

Exchange ActiveSync (EAS) protocol support for a [`@rapidmx/restapi`](https://github.com/RapidMX/restapi)-based
mail server — covers every command a real mobile client (iOS Mail, Outlook mobile, Android/Samsung Mail) needs
for day-to-day use: `Provision` (configurable password/encryption policy, real per-device acknowledgement
enforcement, and a full three-step `RemoteWipe` flow triggered via `BaseDeviceSyncStateRoute`'s admin-only
`POST /:uid/remote-wipe`), `FolderSync`, `Sync` (`Email`/`Contacts`/`Calendar`/`Tasks`, multiple
`<Collection>`s per request, client-originated `Add`/`Change`/`Delete` for every collection type including
Email Drafts), `SendMail`/`SmartForward`/`SmartReply`, `ItemOperations`, `Ping`, `Search` (GAL),
`MeetingResponse`, `Settings` (including `Oof`), `GetItemEstimate`, `MoveItems`, and `ResolveRecipients`.

Deliberately out of scope: `Notes` sync, `DocumentLibrary`/file-share access, `RightsManagement`/IRM, `Find`,
and `AirNotification` — legacy/rarely-used corners of the spec that even mature reference servers only
partially implement; a client probing capabilities via `OPTIONS` correctly sees these as unsupported (see
below), same as any other command this library doesn't register a handler for.

It authenticates with the same JWT the rest of a RapidREST app's routes already use — no separate
EAS-specific login flow — which means a real native device (rather than a test client that already has a
token) needs an OAuth 2.0 Authorization Server role in front of it to obtain one; that piece is tracked as a
follow-up in `@rapidrest/auth`, not this package.

A [`@rapidmx/autodiscover`](https://github.com/RapidMX/autodiscover) mount lets real clients find this
package's endpoint from just an email address.

Responds to a client's `OPTIONS` capability probe with real `MS-ASProtocolVersions`/`MS-ASProtocolCommands`
headers (versions `14.0`/`14.1`/`16.0`/`16.1`, matching the MIME-based `SendMail`/`SmartForward`/`SmartReply` this package
actually implements). This requires `@rapidrest/service-core` >=1.5.0 (the version that added
`hasExplicitOptionsRoute()`, letting this route's own `OPTIONS` handler run instead of the framework's global
CORS middleware always answering with a blanket preflight `204`) — this package's own `peerDependencies`
doesn't hard-pin that minimum since every other command still works fine on an older `service-core`, it just
means `OPTIONS` falls back to the bare `204` and a client falls back to trying its first `POST` directly.

## Usage

Mount `EasRouteMongo`/`EasRouteSQL` (from `@rapidmx/activesync/mongo` or `/sql`) at the protocol's well-known
path with a one-line subclass:

```ts
import { EasRouteMongo } from "@rapidmx/activesync/mongo";
import { RouteDecorators } from "@rapidrest/service-core";
const { Route } = RouteDecorators;

@Route("/Microsoft-Server-ActiveSync")
export class MyEasRoute extends EasRouteMongo {}
```

Requires a [`@rapidmx/restapi`](https://github.com/RapidMX/restapi)-backed application (models, blob
storage, and scan pipeline).

## Status

Complete. This package was carved out of the former `@rapidrest/mail` monolith — see `.claude/NOTES.md` for
the split's own rationale and history.
