import type { Config, Context } from "@netlify/functions";
import { handleChat, preflight } from "../../server/public-api";
import { crawlTrigger } from "../../server/internal";

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return preflight(req);
  return handleChat(req, { ip: context.ip, waitUntil: (p) => context.waitUntil(p), triggerCrawl: crawlTrigger(new URL(req.url).origin) });
};

export const config: Config = {
  path: "/api/chat",
  method: ["POST", "OPTIONS"],
  // Edge rate limit (in addition to per-visitor/per-IP limits in the database).
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
