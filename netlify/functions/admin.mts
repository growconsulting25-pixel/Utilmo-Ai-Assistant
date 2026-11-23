import type { Config, Context } from "@netlify/functions";
import { handleAdmin } from "../../server/admin-api";
import { crawlTrigger } from "../../server/internal";

export default async (req: Request, context: Context) =>
  handleAdmin(req, { ip: context.ip, waitUntil: (p) => context.waitUntil(p), triggerCrawl: crawlTrigger(new URL(req.url).origin) });

export const config: Config = { path: "/api/admin/*" };
