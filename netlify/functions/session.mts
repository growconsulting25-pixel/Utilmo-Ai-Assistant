import type { Config } from "@netlify/functions";
import { handleSessionDelete, handleSessionGet, preflight } from "../../server/public-api";

export default async (req: Request) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method === "DELETE") return handleSessionDelete(req);
  return handleSessionGet(req);
};
export const config: Config = { path: "/api/session", method: ["GET", "DELETE", "OPTIONS"] };
