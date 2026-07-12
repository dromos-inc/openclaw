import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "voice-room",
  path: "/voice-room",
  component: () =>
    import("./voice-room-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-voice-room-page></openclaw-voice-room-page>`,
    })),
});
