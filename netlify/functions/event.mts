import type { Config, Context } from "@netlify/functions";
import { handleEvent, preflight } from "../../server/public-api";

export default async (req: Request, context: Context) => (req.method === "OPTIONS" ? preflight(req) : handleEvent(req, { ip: context.ip }));
export const config: Config = { path: "/api/event", method: ["POST", "OPTIONS"], rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] } };
