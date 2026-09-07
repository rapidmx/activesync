import { RouteDecorators } from "@rapidrest/service-core";
import { DeviceSyncStateRouteSQL } from "../../../src/sql/DeviceSyncStateRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/device-sync-state")
export class DeviceSyncStateRoute extends DeviceSyncStateRouteSQL {}
