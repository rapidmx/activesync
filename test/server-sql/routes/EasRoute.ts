import { RouteDecorators } from "@rapidrest/service-core";
import { EasRouteSQL } from "../../../src/sql/EasRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/eas")
export class EasRoute extends EasRouteSQL {}
