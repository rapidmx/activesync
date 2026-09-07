import { RouteDecorators } from "@rapidrest/service-core";
import { MessageRouteSQL } from "@rapidmx/restapi/sql";
const { Route } = RouteDecorators;

@Route("/sql/messages")
export class MessageRoute extends MessageRouteSQL {}
