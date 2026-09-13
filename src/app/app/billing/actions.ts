"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { portalUrl } from "@/lib/billing/subscription";
import { currentClient } from "@/lib/clients";

/** Stripe-hosted portal on the agency's account: change card, see invoices, cancel. */
export async function openPortal() {
  const { client } = await currentClient();
  if (!client) throw new Error("No business selected.");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3410";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const url = await portalUrl(client.id, `${proto}://${host}/app/billing`);
  redirect(url);
}
