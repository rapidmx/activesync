# RapidMX: ActiveSync

[![CI](https://github.com/RapidMX/activesync/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/RapidMX/activesync/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/RapidMX/activesync/badge.svg?branch=main)](https://coveralls.io/github/RapidMX/activesync?branch=main)
[![npm version](https://img.shields.io/npm/v/@rapidmx/activesync)](https://www.npmjs.com/package/@rapidmx/activesync)

Exchange ActiveSync (EAS) protocol support for a [`@rapidmx/restapi`](https://github.com/RapidMX/restapi)-based
mail server — covers the pragmatic command subset a real mobile client (iOS Mail, Outlook mobile,
Android/Samsung Mail) needs for day-to-day use: `Provision`, `FolderSync`, `Sync`
(`Email`/`Contacts`/`Calendar`/`Tasks`), `SendMail`/`SmartForward`/`SmartReply`, `ItemOperations`, `Ping`,
`Search` (GAL), `MeetingResponse`, and `Settings`.

It authenticates with the same JWT the rest of a RapidREST app's routes already use — no separate
EAS-specific login flow — which means a real native device (rather than a test client that already has a
token) needs an OAuth 2.0 Authorization Server role in front of it to obtain one; that piece is tracked as a
follow-up in `@rapidrest/auth`, not this package.

A [`@rapidmx/autodiscover`](https://github.com/RapidMX/autodiscover) mount lets real clients find this
package's endpoint from just an email address.

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
