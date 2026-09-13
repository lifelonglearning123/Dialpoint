"use client";

import { useEffect, useRef, useState } from "react";

type Call = {
  accept: () => void;
  reject: () => void;
  disconnect: () => void;
  parameters: Record<string, string>;
  on: (ev: string, fn: (x?: unknown) => void) => void;
};
type Device = { destroy: () => void; register: () => Promise<void>; connect: (o: { params: Record<string, string> }) => Promise<Call>; on: (ev: string, fn: (x?: unknown) => void) => void };

/** Browser softphone: registers as this user's identity and answers calls routed to "the browser". */
export default function SoftphonePage() {
  const [status, setStatus] = useState("starting…");
  const [incoming, setIncoming] = useState<Call | null>(null);
  const [outbound, setOutbound] = useState<Call | null>(null);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [dial, setDial] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const deviceRef = useRef<Device | null>(null);
  const add = (s: string) => setLog((l) => [new Date().toLocaleTimeString() + " " + s, ...l].slice(0, 50));

  useEffect(() => {
    let alive = true;
    (async () => {
      const { Device } = await import("@twilio/voice-sdk");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        setStatus("microphone blocked: " + (e as Error).message + " (allow the microphone in the address bar and reload)");
        return;
      }
      const res = await fetch("/api/voice/token");
      const j = await res.json();
      if (!res.ok) {
        setStatus(j.error ?? "could not get a token");
        return;
      }
      setCallerId(j.callerId ?? null);
      const device = new Device(j.token, { logLevel: 1 }) as unknown as Device;
      deviceRef.current = device;
      device.on("registered", () => alive && setStatus(`ready · ${j.identity}`));
      device.on("unregistered", () => alive && setStatus("disconnected"));
      device.on("error", (e) => add("error " + (e as Error).message));
      device.on("incoming", (c) => {
        const call = c as Call;
        add("incoming from " + call.parameters.From);
        setIncoming(call);
        call.on("disconnect", () => {
          add("call ended");
          setIncoming(null);
        });
        call.on("cancel", () => {
          add("caller hung up or answered elsewhere");
          setIncoming(null);
        });
      });
      await device.register();
    })().catch((e) => setStatus("failed: " + e.message));
    return () => {
      alive = false;
      deviceRef.current?.destroy();
    };
  }, []);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Softphone</h1>
        <p className="text-sm text-slate-500">Keep this page open to answer calls routed to your browser. Status: {status}</p>
      </div>

      {incoming && (
        <div className="card border-2 border-emerald-400">
          <div className="text-sm text-slate-500">Incoming call</div>
          <div className="text-xl font-semibold tabular-nums">{incoming.parameters.From}</div>
          <div className="mt-4 flex gap-2">
            <button
              className="btn-primary"
              onClick={() => {
                incoming.accept();
                add("accepted");
              }}
            >
              Accept
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                incoming.reject();
                add("declined");
                setIncoming(null);
              }}
            >
              Decline
            </button>
            <button className="btn-secondary" onClick={() => incoming.disconnect()}>
              Hang up
            </button>
          </div>
        </div>
      )}

      <div className="card space-y-3">
        <div className="text-sm font-medium">Make a call{callerId ? ` from ${callerId}` : ""}</div>
        {outbound ? (
          <div className="flex items-center justify-between">
            <span className="tabular-nums">On a call to {dial}</span>
            <button className="btn-secondary" onClick={() => outbound.disconnect()}>
              Hang up
            </button>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!deviceRef.current || !dial) return;
              try {
                const call = await deviceRef.current.connect({ params: { To: dial } });
                setOutbound(call);
                add("calling " + dial);
                call.on("disconnect", () => {
                  add("call ended");
                  setOutbound(null);
                });
                call.on("error", (err) => add("call error " + (err as Error).message));
              } catch (err) {
                add("could not call: " + (err as Error).message);
              }
            }}
          >
            <input value={dial} onChange={(e) => setDial(e.target.value)} placeholder="+447700900123" className="input" disabled={!callerId} />
            <button className="btn-primary" disabled={!callerId}>
              Call
            </button>
          </form>
        )}
        {!callerId && <p className="text-xs text-slate-500">Outbound calls need an active number on this business.</p>}
      </div>

      <pre className="card whitespace-pre-wrap text-xs text-slate-600">{log.join("\n") || "No activity yet."}</pre>
    </div>
  );
}
