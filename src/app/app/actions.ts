"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireClientAccess, requireSession } from "@/lib/auth";
import { CLIENT_COOKIE } from "@/lib/clients";

export async function switchClient(formData: FormData) {
  const session = await requireSession();
  const clientId = String(formData.get("clientId") ?? "");
  await requireClientAccess(session, clientId);
  const store = await cookies();
  store.set(CLIENT_COOKIE, clientId, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  redirect("/app");
}
