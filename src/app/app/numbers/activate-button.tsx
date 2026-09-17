"use client";

import { useActionState } from "react";
import { activateNumberAction, type ActivateState } from "./actions";

/** "Activate now" with the purchase result shown inline, never a crash page. */
export function ActivateButton({ numberId }: { numberId: string }) {
  const [state, action, pending] = useActionState<ActivateState, FormData>(activateNumberAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="numberId" value={numberId} />
      <button type="submit" disabled={pending} className="btn-secondary">
        {pending ? "Buying the number…" : "Activate now"}
      </button>
      {state && !state.ok && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <div className="font-medium">The number could not be bought.</div>
          <div className="mt-1 break-words">{state.error}</div>
        </div>
      )}
      {state?.ok && <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Bought. The number is live.</div>}
    </form>
  );
}
