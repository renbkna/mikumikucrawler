import { t } from "elysia";
export { PageContentResponseSchema } from "../../shared/contracts/schemas.js";
import { PositiveIntegerIdSchema } from "./http.js";

export type { PageContentResponse } from "../../shared/contracts/index.js";

export const PageContentParamsSchema = t.Object({
	id: PositiveIntegerIdSchema,
});
