import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agents } from "@/db/shared";

export type ClientAgent = { id: string; name: string; platform: string };

/**
 * A client's active AI agents, as built in Signal. `id` is the platform's own
 * agent id (what Retell calls `agent_id`). Only Retell agents can take a call
 * from this app today; the rest are listed so the editor can say so.
 */
export async function clientAgents(clientId: string): Promise<ClientAgent[]> {
  const rows = await db.query.agents.findMany({
    where: and(eq(agents.clientId, clientId), eq(agents.active, true)),
    columns: { platformAgentId: true, name: true, platform: true },
  });
  return rows.map((r) => ({ id: r.platformAgentId, name: r.name, platform: r.platform })).sort((a, b) => a.name.localeCompare(b.name));
}
