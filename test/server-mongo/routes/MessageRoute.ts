import { RouteDecorators } from "@rapidrest/service-core";
import { MessageRouteMongo } from "@rapidmx/restapi/mongo";
const { Route } = RouteDecorators;

@Route("/mongo/messages")
export class MessageRoute extends MessageRouteMongo {}
