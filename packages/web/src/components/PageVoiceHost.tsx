"use client";

import { useEffect, useRef, useState } from "react";
import { ChatVoiceControls } from "@/components/ChatVoiceControls";
import { PAGE_ID_RE } from "@/lib/store-proxy";

interface VoiceIdentity {
  page: string;
  chat: string;
  nonce: string;
}
export function PageVoiceHost() {
  const [identity, setIdentity] = useState<VoiceIdentity | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const page = query.get("page") ?? "";
    const chat = query.get("chat") ?? "";
    const nonce = query.get("nonce") ?? "";
    if (
      window.parent === window ||
      !PAGE_ID_RE.test(page) ||
      !/^[A-Za-z0-9-]{1,64}$/.test(chat) ||
      !/^[A-Za-z0-9-]{8,64}$/.test(nonce)
    )
      return;
    const current = { page, chat, nonce };
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== window.parent ||
        typeof event.data !== "object" ||
        event.data === null
      )
        return;
      const data = event.data as Record<string, unknown>;
      if (
        data.type === "spur:voice-connect" &&
        data.page === page &&
        data.chat === chat &&
        data.nonce === nonce
      )
        setIdentity(current);
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "spur:voice-ready", ...current }, window.location.origin);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    const controls = controlsRef.current;
    if (!identity || !controls) return;
    const reportSize = () =>
      window.parent.postMessage(
        {
          type: "spur:voice-size",
          ...identity,
          height: Math.ceil(controls.getBoundingClientRect().height),
        },
        window.location.origin,
      );
    const observer = new ResizeObserver(reportSize);
    observer.observe(controls);
    reportSize();
    return () => observer.disconnect();
  }, [identity]);
  return identity ? (
    <div ref={controlsRef}>
      <ChatVoiceControls
        contextKey={`page-chat:${identity.page}:${identity.chat}`}
        onTranscribed={(text) => {
          window.parent.postMessage(
            { type: "spur:voice-transcript", ...identity, text },
            window.location.origin,
          );
        }}
      />
    </div>
  ) : null;
}
