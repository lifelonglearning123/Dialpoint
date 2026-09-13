import Stripe from "stripe";
import { env } from "@/env";

/**
 * Stripe platform client (same STRIPE_SECRET_KEY as Signal). Every customer,
 * subscription, price and meter lives on the AGENCY's connected account, so
 * each call passes `forAccount(agency.stripeAccountId)` as request options.
 * The API version is the SDK's pinned default (stripe 22.x).
 */
let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY).");
  if (!client) client = new Stripe(env.STRIPE_SECRET_KEY, { typescript: true });
  return client;
}

export function forAccount(stripeAccountId: string): Stripe.RequestOptions {
  if (!stripeAccountId) throw new Error("This agency has not connected Stripe yet.");
  return { stripeAccount: stripeAccountId };
}

export function stripeConfigured() {
  return !!env.STRIPE_SECRET_KEY;
}
