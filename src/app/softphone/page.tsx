"use client";

import { useEffect, useRef, useState } from "react";

type Call = { accept: () => void; reject: () => void; disconnect: () => void; parameters: Record<string, string> };

/** Minimal spike softphone: registers as the <Client> identity and answers inbound calls. */
export default function SoftphonePage() {
  const [status, setStatus] = useState("loading sdk");
  const [incoming, setIncoming] = useState<Call | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [testNumber, setTestNumber] = useState("");
  const [outbound, setOutbound] = useState<Call | null>(null);
  const deviceRef = useRef<{ destroy: () => void; connect: (o: { params: Record<string, string> }) => Promise<Call> } | null>(null);
  const add = (s: string) => setLog((l) => [new Date().toLocaleTimeString() + " " + s, ...l].slice(0, 50));

  useEffect(() => {
    let alive = true;
    (async () => {
      const { Device } = await import("@twilio/voice-sdk");
      // Ask for the microphone first so Chrome shows the permission prompt and
      // exposes real audio devices to the SDK.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        add("microphone permission granted");
      } catch (e) {
        setStatus("microphone blocked: " + (e as Error).message + " (click the camera/mic icon in the address bar and allow)");
        return;
      }
      const res = await fetch("/api/voice/token");
      const j = await res.json();
      if (!res.ok) { setStatus("token error: " + j.error); return; }
      const device = new Device(j.token, { logLevel: 1 });
      deviceRef.current = device as unknown as typeof deviceRef.current;
      setTestNumber(j.testNumber ?? "");
      device.on("registered", () => { if (alive) { setStatus(`registered as ${j.identity}`); add("registered"); } });
      device.on("error", (e: Error) => add("error " + e.message));
      device.on("incoming", (call: Call) => {
        add("incoming from " + call.parameters.From);
        setIncoming(call);
        (call as unknown as { on: (ev: string, fn: () => void) => void }).on("disconnect", () => { add("disconnected"); setIncoming(null); });
        (call as unknown as { on: (ev: string, fn: () => void) => void }).on("cancel", () => { add("cancelled"); setIncoming(null); });
      });
      await device.register();
    })().catch((e) => setStatus("failed: " + e.message));
    return () => { alive = false; deviceRef.current?.destroy(); };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 520 }}>
      <h1>Spike softphone</h1>
      <p>Status: {status}</p>
      {testNumber && !outbound && (
        <button
          style={{ marginBottom: 16 }}
          onClick={async () => {
            try {
              add("connecting to " + testNumber);
              const call = await deviceRef.current!.connect({ params: { To: testNumber } });
              setOutbound(call);
              const on = (call as unknown as { on: (ev: string, fn: (x?: unknown) => void) => void }).on;
              on.call(call, "ringing", () => add("ringing"));
              on.call(call, "accept", () => add("connected"));
              on.call(call, "error", (e) => add("call error " + (e as Error).message));
              on.call(call, "disconnect", () => { add("outbound ended"); setOutbound(null); });
            } catch (e) {
              add("connect failed: " + (e as Error).message);
            }
          }}
        >
          Call the test line {testNumber}
        </button>
      )}
      {outbound && (
        <div style={{ border: "1px solid #999", padding: 16, marginBottom: 16 }}>
          <p>On a call to {testNumber}</p>
          <button onClick={() => outbound.disconnect()}>Hang up</button>
        </div>
      )}
      {incoming && (
        <div style={{ border: "1px solid #999", padding: 16, marginBottom: 16 }}>
          <p>Incoming call from {incoming.parameters.From}</p>
          <button onClick={() => { incoming.accept(); add("accepted"); }} style={{ marginRight: 8 }}>Accept</button>
          <button onClick={() => { incoming.reject(); add("rejected"); setIncoming(null); }} style={{ marginRight: 8 }}>Decline</button>
          <button onClick={() => { incoming.disconnect(); }}>Hang up</button>
        </div>
      )}
      <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </main>
  );
}
