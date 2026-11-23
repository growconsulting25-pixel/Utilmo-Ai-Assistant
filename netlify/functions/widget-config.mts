import type { Config } from "@netlify/functions";
import { handleConfig, preflight } from "../../server/public-api";

export default async (req: Request) => (req.method === "OPTIONS" ? preflight(req) : handleConfig(req));
export const config: Config = { path: "/api/widget-config", method: ["GET", "OPTIONS"] };
