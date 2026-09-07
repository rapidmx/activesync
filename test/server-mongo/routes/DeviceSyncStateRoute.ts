import { RouteDecorators } from "@rapidrest/service-core";
import { DeviceSyncStateRouteMongo } from "../../../src/mongo/DeviceSyncStateRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/device-sync-state")
export class DeviceSyncStateRoute extends DeviceSyncStateRouteMongo {}
