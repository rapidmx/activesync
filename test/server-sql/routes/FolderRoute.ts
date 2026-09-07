import { RouteDecorators } from "@rapidrest/service-core";
import { FolderRouteSQL } from "@rapidmx/restapi/sql";
const { Route } = RouteDecorators;

@Route("/sql/folders")
export class FolderRoute extends FolderRouteSQL {}
