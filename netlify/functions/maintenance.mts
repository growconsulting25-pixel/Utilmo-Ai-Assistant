import type { Config } from "@netlify/functions";
import { runMaintenance } from "../../server/maintenance";

/** Every 10 minutes (UTC): webhook retries, retention purge, embeddings backfill. */
export default async () => {
  const r = await runMaintenance(25_000);
  console.log("[maintenance]", JSON.stringify(r));
};
export const config: Config = { schedule: "*/10 * * * *" };
