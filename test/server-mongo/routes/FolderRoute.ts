import { RouteDecorators } from "@rapidrest/service-core";
import { FolderRouteMongo } from "@rapidmx/restapi/mongo";
const { Route } = RouteDecorators;

@Route("/mongo/folders")
export class FolderRoute extends FolderRouteMongo {}
