import type { Config, Context } from "@netlify/functions";
import { handleBookingWebhook } from "../../server/booking";

export default async (req: Request, context: Context) => handleBookingWebhook(req, context.params.id);
export const config: Config = { path: "/api/booking/webhook/:id", method: "POST" };
