import { headers } from "next/headers";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencyDomains } from "@/db/schema";
import { agencies } from "@/db/shared";
import { env } from "@/env";

/**
 * Host-based tenancy, same rule as Signal: one deployment, the request's Host
 * decides the agency. This app's hostnames live in tb.agency_domains (Signal's
 * agencies.custom_domain is Signal's own workspace host, e.g. signal.<domain>,
 * and this product runs on a different host, e.g. numbers.<domain>).
 *
 *   1. tb.agency_domains.host, verified = true
 *   2. DEFAULT_AGENCY_SLUG (dev / localhost)
 *   3. null → caller shows "not configured", never a default brand
 */
export type ResolvedAgency = {
  id: string;
  name: string;
  slug: string;
  brandLogoUrl: string | null;
  brandFaviconUrl: string | null;
  brandPrimaryColor: string | null;
  locale: string;
  ownerEmail: string | null;
  currency: string;
  stripeAccountId: string | null;
};

const COLUMNS = {
  id: agencies.id,
  name: agencies.name,
  slug: agencies.slug,
  brandLogoUrl: agencies.brandLogoUrl,
  brandFaviconUrl: agencies.brandFaviconUrl,
  brandPrimaryColor: agencies.brandPrimaryColor,
  locale: agencies.locale,
  ownerEmail: agencies.ownerEmail,
  currency: agencies.clientCurrency,
  stripeAccountId: agencies.stripeAccountId,
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; agency: ResolvedAgency | null }>();

export function invalidateAgencyResolution() {
  cache.clear();
}

function normalizeHost(raw: string) {
  return raw.toLowerCase().split(":")[0].trim();
}

export async function resolveAgencyFromHost(rawHost: string): Promise<ResolvedAgency | null> {
  const host = normalizeHost(rawHost);
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.agency;

  let agency: ResolvedAgency | null = null;

  const [byDomain] = await db
    .select(COLUMNS)
    .from(agencyDomains)
    .innerJoin(agencies, eq(agencyDomains.agencyId, agencies.id))
    .where(sql`lower(${agencyDomains.host}) = ${host} and ${agencyDomains.verified} = true`)
    .limit(1);
  agency = byDomain ?? null;

  if (!agency && env.DEFAULT_AGENCY_SLUG) {
    const [byDefault] = await db.select(COLUMNS).from(agencies).where(eq(agencies.slug, env.DEFAULT_AGENCY_SLUG)).limit(1);
    agency = byDefault ?? null;
  }

  cache.set(host, { at: Date.now(), agency });
  return agency;
}

export async function resolveAgency(): Promise<ResolvedAgency | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  if (!host) return null;
  return resolveAgencyFromHost(host);
}

export async function requireAgency(): Promise<ResolvedAgency> {
  const agency = await resolveAgency();
  if (!agency) throw new Error("No agency is configured for this domain.");
  return agency;
}
