import { cookies } from "next/headers";
import { requireSession, visibleClients, type SessionContext } from "@/lib/auth";

const COOKIE = "tb_client";

/**
 * The client (customer org) the signed-in user is currently working in.
 * Client users usually have exactly one; agency staff switch between all of
 * the agency's clients. Remembered in a cookie, validated against access on
 * every read so a stale cookie can never leak another client's data.
 */
export async function currentClient(session?: SessionContext) {
  const s = session ?? (await requireSession());
  const list = await visibleClients(s);
  const store = await cookies();
  const wanted = store.get(COOKIE)?.value;
  const client = list.find((c) => c.id === wanted) ?? list[0] ?? null;
  return { session: s, client, clients: list };
}

export const CLIENT_COOKIE = COOKIE;
