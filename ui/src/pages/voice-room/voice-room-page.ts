import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { RealtimeTalkSession, type RealtimeTalkStatus } from "../chat/realtime-talk.ts";

type VoiceRoomAgent = {
  id: string;
  label: string;
  voice: string;
};

type VoiceRoomEntry = {
  id: string;
  speaker: string;
  text: string;
  pending?: boolean;
  error?: boolean;
};

type VoiceRoomBoard = {
  id: string;
  label: string;
  description?: string;
  archived?: boolean;
};

type VoiceRoomTarget = "first" | "second" | "both";
type VoiceRoomOutput = "silent" | "speak";

const DEFAULT_AGENTS: VoiceRoomAgent[] = [
  { id: "mark", label: "Mark", voice: "cedar" },
  { id: "rp", label: "Lexi RP", voice: "shimmer" },
];
const SILENT_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

function sanitizeSessionSegment(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

function buildAgentRoomSessionKey(agentId: string, boardId: string): string {
  return `agent:${sanitizeSessionSegment(agentId, "agent")}:voice-room:board:${sanitizeSessionSegment(
    boardId,
    "default",
  )}`;
}

function normalizeAgentLabel(agent: AgentsListResult["agents"][number]): string {
  return agent.identity?.name?.trim() || agent.name?.trim() || agent.id;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text.trim();
  }
  const content = Array.isArray(record.content) ? record.content : [];
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const block = part as Record<string, unknown>;
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function readChatPayload(payload: unknown): {
  runId?: string;
  state?: string;
  deltaText?: string;
  message?: unknown;
  errorMessage?: string;
} | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return payload as {
    runId?: string;
    state?: string;
    deltaText?: string;
    message?: unknown;
    errorMessage?: string;
  };
}

function mergeDefaultAgents(agents: VoiceRoomAgent[]): VoiceRoomAgent[] {
  const byId = new Map(agents.map((agent) => [agent.id.toLowerCase(), agent]));
  for (const fallback of DEFAULT_AGENTS) {
    if (!byId.has(fallback.id)) {
      agents.push(fallback);
    }
  }
  return agents;
}

function isLexiAgentId(agentId: string): boolean {
  const normalized = agentId.toLowerCase();
  return normalized === "lexi" || normalized === "rp" || normalized === "lexi-rp";
}

function normalizeBoardsPayload(payload: unknown): VoiceRoomBoard[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const boards = Array.isArray((payload as { boards?: unknown }).boards)
    ? (payload as { boards: unknown[] }).boards
    : [];
  return boards
    .flatMap((board): VoiceRoomBoard[] => {
      if (!board || typeof board !== "object") {
        return [];
      }
      const record = board as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id) {
        return [];
      }
      const label = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
      return [
        {
          id,
          label,
          ...(typeof record.description === "string" && record.description.trim()
            ? { description: record.description.trim() }
            : {}),
          archived: typeof record.archivedAt === "number",
        },
      ];
    })
    .filter((board) => !board.archived);
}

function mergeDefaultBoard(boards: VoiceRoomBoard[]): VoiceRoomBoard[] {
  const byId = new Map(boards.map((board) => [board.id.toLowerCase(), board]));
  const defaultBoard = byId.get("default") ?? {
    id: "default",
    label: "Default board",
    description: "Private room for uncategorized work.",
  };
  return [defaultBoard, ...boards.filter((board) => board.id.toLowerCase() !== "default")].sort(
    (left, right) => {
      if (left.id === "default") {
        return -1;
      }
      if (right.id === "default") {
        return 1;
      }
      return left.label.localeCompare(right.label);
    },
  );
}

export class VoiceRoomPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private connected = false;
  @state() private loadingAgents = false;
  @state() private loadingBoards = false;
  @state() private agentOptions: VoiceRoomAgent[] = DEFAULT_AGENTS;
  @state() private boardOptions: VoiceRoomBoard[] = mergeDefaultBoard([]);
  @state() private selected: [string, string] = ["mark", "rp"];
  @state() private selectedBoardId = "default";
  @state() private target: VoiceRoomTarget = "second";
  @state() private output: VoiceRoomOutput = "silent";
  @state() private draft = "";
  @state() private status: RealtimeTalkStatus = "idle";
  @state() private statusDetail = "";
  @state() private speakingEntryIds = new Set<string>();
  @state() private entries: VoiceRoomEntry[] = [
    {
      id: "welcome",
      speaker: "Room",
      text: "Pick the pair, choose who answers, then speak or type.",
    },
  ];

  private client: GatewayBrowserClient | null = null;
  private realtime: RealtimeTalkSession | null = null;
  private audioOutput = new Audio();
  private audioUnlocked = false;
  private audioUnlockPromise: Promise<void> | null = null;
  private activeVoiceAgentId = "rp";
  private stopGateway: (() => void) | null = null;
  private stopEvents: (() => void) | null = null;
  private pendingRuns = new Map<
    string,
    { agent: VoiceRoomAgent; entryId: string; resolve: () => void }
  >();

  override connectedCallback() {
    super.connectedCallback();
    this.stopGateway = this.context.gateway.subscribe((snapshot) => {
      this.connected = snapshot.connected;
      if (snapshot.client !== this.client) {
        this.stopRealtime();
        this.client = snapshot.client;
        this.pendingRuns.clear();
        this.loadAgents();
        this.loadBoards();
      }
    });
    this.stopEvents = this.context.gateway.subscribeEvents((event) =>
      this.handleGatewayEvent(event),
    );
    const snapshot = this.context.gateway.snapshot;
    this.connected = snapshot.connected;
    this.client = snapshot.client;
    this.loadAgents();
    this.loadBoards();
  }

  override disconnectedCallback() {
    this.stopRealtime();
    this.stopGateway?.();
    this.stopGateway = null;
    this.stopEvents?.();
    this.stopEvents = null;
    this.client = null;
    super.disconnectedCallback();
  }

  private loadAgents() {
    const client = this.client;
    if (!client || this.loadingAgents) {
      return;
    }
    this.loadingAgents = true;
    void this.context.agents
      .ensureList()
      .then((result) => {
        if (!result || client !== this.client) {
          return;
        }
        const options = result.agents.map((agent) => ({
          id: agent.id,
          label: normalizeAgentLabel(agent),
          voice: this.voiceForAgent(agent.id),
        }));
        this.agentOptions = mergeDefaultAgents(options);
        this.selected = [
          this.resolveSelectedAgentId(this.selected[0], "mark"),
          this.resolveSelectedAgentId(this.selected[1], "rp"),
        ];
      })
      .catch((error: unknown) => {
        this.appendEntry("Room", `Could not load agents: ${String(error)}`, { error: true });
      })
      .finally(() => {
        if (client === this.client) {
          this.loadingAgents = false;
        }
      });
  }

  private loadBoards() {
    const client = this.client;
    if (!client || this.loadingBoards) {
      return;
    }
    this.loadingBoards = true;
    void client
      .request("workboard.boards.list", {})
      .then((payload) => {
        if (client !== this.client) {
          return;
        }
        this.boardOptions = mergeDefaultBoard(normalizeBoardsPayload(payload));
        if (!this.boardOptions.some((board) => board.id === this.selectedBoardId)) {
          this.selectBoardRoom("default");
        }
      })
      .catch((error: unknown) => {
        this.appendEntry("Room", `Could not load workboard rooms: ${String(error)}`, {
          error: true,
        });
      })
      .finally(() => {
        if (client === this.client) {
          this.loadingBoards = false;
        }
      });
  }

  private voiceForAgent(agentId: string): string {
    const normalized = agentId.toLowerCase();
    if (normalized === "mark") {
      return "cedar";
    }
    if (isLexiAgentId(normalized)) {
      return "shimmer";
    }
    return "configured";
  }

  private resolveSelectedAgentId(current: string, fallback: string): string {
    if (this.agentOptions.some((agent) => agent.id === current)) {
      return current;
    }
    if (fallback === "rp") {
      return (
        this.agentOptions.find((agent) => isLexiAgentId(agent.id))?.id ??
        this.agentOptions.find((agent) => agent.id.toLowerCase() === fallback)?.id ??
        current
      );
    }
    return this.agentOptions.find((agent) => agent.id.toLowerCase() === fallback)?.id ?? current;
  }

  private selectedAgents(): VoiceRoomAgent[] {
    const first = this.agentById(this.selected[0]) ?? DEFAULT_AGENTS[0];
    const second = this.agentById(this.selected[1]) ?? DEFAULT_AGENTS[1];
    if (this.target === "first") {
      return [first];
    }
    if (this.target === "second") {
      return [second];
    }
    return first.id === second.id ? [first] : [first, second];
  }

  private activeVoiceAgent(): VoiceRoomAgent {
    return this.selectedAgents()[0] ?? this.agentById(this.activeVoiceAgentId) ?? DEFAULT_AGENTS[1];
  }

  private selectedBoard(): VoiceRoomBoard {
    return (
      this.boardOptions.find((board) => board.id === this.selectedBoardId) ??
      this.boardOptions[0] ?? {
        id: "default",
        label: "Default board",
      }
    );
  }

  private agentById(agentId: string): VoiceRoomAgent | undefined {
    return this.agentOptions.find((agent) => agent.id === agentId);
  }

  private currentRoomSessionKey(agentId: string): string {
    return buildAgentRoomSessionKey(agentId, this.selectedBoard().id);
  }

  private selectBoardRoom(boardId: string) {
    if (this.selectedBoardId === boardId) {
      return;
    }
    this.stopRealtime();
    this.pendingRuns.clear();
    this.selectedBoardId = boardId;
    const board = this.boardOptions.find((entry) => entry.id === boardId) ?? {
      id: boardId,
      label: boardId,
    };
    this.entries = [
      {
        id: `welcome-${sanitizeSessionSegment(board.id, "board")}`,
        speaker: "Room",
        text: `${board.label}: private board room. Messages here stay in this board-specific agent session.`,
      },
    ];
  }

  private appendEntry(
    speaker: string,
    text: string,
    options: { pending?: boolean; error?: boolean; id?: string } = {},
  ): string {
    const id = options.id ?? generateUUID();
    this.entries = [
      ...this.entries,
      { id, speaker, text, pending: options.pending, error: options.error },
    ].slice(-80);
    return id;
  }

  private updateEntry(id: string, patch: Partial<VoiceRoomEntry>) {
    this.entries = this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  }

  private setEntrySpeaking(id: string, speaking: boolean) {
    const next = new Set(this.speakingEntryIds);
    if (speaking) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.speakingEntryIds = next;
  }

  private async toggleRealtime() {
    if (this.realtime) {
      this.stopRealtime();
      return;
    }
    const client = this.client;
    if (!client || !this.connected) {
      this.appendEntry("Room", "Connect to the gateway before starting voice.", { error: true });
      return;
    }
    const agent = this.activeVoiceAgent();
    this.activeVoiceAgentId = agent.id;
    this.statusDetail = "";
    this.realtime = new RealtimeTalkSession(
      client,
      this.currentRoomSessionKey(agent.id),
      {
        onStatus: (status, detail) => {
          this.status = status;
          this.statusDetail = detail ?? "";
        },
        onTranscript: (entry) => {
          const text = entry.text.trim();
          if (text) {
            this.appendEntry(entry.role === "user" ? "You" : agent.label, text);
          }
        },
      },
      {
        transport: "webrtc",
        voice: agent.voice === "configured" ? undefined : agent.voice,
      },
    );
    try {
      await this.realtime.start();
    } catch (error) {
      this.appendEntry("Voice", String(error), { error: true });
      this.stopRealtime();
    }
  }

  private stopRealtime() {
    this.realtime?.stop();
    this.realtime = null;
    this.status = "idle";
    this.statusDetail = "";
  }

  private async unlockAudioOutput() {
    if (this.audioUnlocked) {
      return;
    }
    if (this.audioUnlockPromise) {
      return this.audioUnlockPromise;
    }
    this.audioUnlockPromise = (async () => {
      const audio = this.audioOutput;
      audio.pause();
      audio.src = SILENT_WAV_DATA_URL;
      audio.currentTime = 0;
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      this.audioUnlocked = true;
    })().finally(() => {
      this.audioUnlockPromise = null;
    });
    return this.audioUnlockPromise;
  }

  private async sendTyped() {
    const client = this.client;
    const message = this.draft.trim();
    if (!client || !this.connected || !message) {
      return;
    }
    if (this.output === "speak") {
      try {
        await this.unlockAudioOutput();
      } catch (error) {
        this.appendEntry("Voice", `Could not unlock browser audio: ${String(error)}`, {
          error: true,
        });
      }
    }
    this.draft = "";
    this.appendEntry("You", message);
    const board = this.selectedBoard();
    for (const agent of this.selectedAgents()) {
      await this.sendTypedToAgent(client, agent, board, message);
    }
  }

  private async sendTypedToAgent(
    client: GatewayBrowserClient,
    agent: VoiceRoomAgent,
    board: VoiceRoomBoard,
    message: string,
  ) {
    const runId = generateUUID();
    const entryId = this.appendEntry(agent.label, "Thinking...", { pending: true });
    let resolvePending: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    this.pendingRuns.set(runId, { agent, entryId, resolve: resolvePending });
    try {
      await client.request("chat.send", {
        sessionKey: this.currentRoomSessionKey(agent.id),
        message: `[Private board room: ${board.label} (${board.id})]\n${message}`,
        deliver: false,
        idempotencyKey: runId,
      });
      await completion;
    } catch (error) {
      this.pendingRuns.delete(runId);
      resolvePending();
      this.updateEntry(entryId, {
        text: String(error),
        pending: false,
        error: true,
      });
    }
  }

  private handleGatewayEvent(event: GatewayEventFrame) {
    if (event.event !== "chat") {
      return;
    }
    const payload = readChatPayload(event.payload);
    if (!payload?.runId) {
      return;
    }
    const pending = this.pendingRuns.get(payload.runId);
    if (!pending) {
      return;
    }
    if (payload.state === "delta" && payload.deltaText) {
      const current = this.entries.find((entry) => entry.id === pending.entryId);
      const text = current?.pending
        ? payload.deltaText
        : `${current?.text ?? ""}${payload.deltaText}`;
      this.updateEntry(pending.entryId, { text, pending: false });
      return;
    }
    if (payload.state === "final" || payload.state === "error") {
      const text =
        extractMessageText(payload.message) ||
        payload.errorMessage ||
        (payload.state === "error" ? "Agent run failed." : "");
      this.updateEntry(pending.entryId, {
        text: text || "Done.",
        pending: false,
        error: payload.state === "error",
      });
      this.pendingRuns.delete(payload.runId);
      void this.finishPendingRun(pending, text);
    }
  }

  private async finishPendingRun(
    pending: { agent: VoiceRoomAgent; entryId: string; resolve: () => void },
    text: string,
  ) {
    try {
      if (this.output === "speak" && text) {
        await this.speak(pending.agent, text, pending.entryId);
      }
    } finally {
      pending.resolve();
    }
  }

  private async speak(agent: VoiceRoomAgent, text: string, entryId?: string) {
    const client = this.client;
    if (!client) {
      return;
    }
    if (entryId) {
      this.setEntrySpeaking(entryId, true);
    }
    try {
      const result = await client.request<{ audioBase64?: string; mimeType?: string }>(
        "talk.speak",
        {
          text,
          agentId: agent.id,
          voiceId: agent.voice === "configured" ? undefined : agent.voice,
        },
      );
      if (!result.audioBase64) {
        return;
      }
      const audio = this.audioOutput;
      audio.pause();
      audio.src = `data:${result.mimeType ?? "audio/mpeg"};base64,${result.audioBase64}`;
      audio.currentTime = 0;
      await audio.play();
    } catch (error) {
      this.appendEntry("Voice", `Could not speak ${agent.label}: ${String(error)}`, {
        error: true,
      });
    } finally {
      if (entryId) {
        this.setEntrySpeaking(entryId, false);
      }
    }
  }

  private renderAgentSelect(index: 0 | 1, label: string) {
    return html`
      <label class="voice-room__field">
        <span>${label}</span>
        <select
          .value=${this.selected[index]}
          @change=${(event: Event) => {
            const target = event.currentTarget as HTMLSelectElement;
            const next: [string, string] = [...this.selected];
            next[index] = target.value;
            this.selected = next;
          }}
        >
          ${this.agentOptions.map(
            (agent) => html`<option value=${agent.id}>${agent.label}</option>`,
          )}
        </select>
      </label>
    `;
  }

  private renderTargetButton(value: VoiceRoomTarget, label: string) {
    return html`
      <button
        class="voice-room__segmented-button ${this.target === value ? "is-active" : ""}"
        type="button"
        @click=${() => {
          this.target = value;
        }}
      >
        ${label}
      </button>
    `;
  }

  override render() {
    const voiceAgent = this.activeVoiceAgent();
    const board = this.selectedBoard();
    const voiceLive = this.realtime !== null;
    const statusText =
      this.status === "idle"
        ? "Ready"
        : this.statusDetail || this.status[0].toUpperCase() + this.status.slice(1);
    return html`
      <section class="voice-room">
        <header class="voice-room__header">
          <div>
            <div class="page-title">Voice Room</div>
            <div class="page-sub">
              ${board.label}: private board room with voice and silent text.
            </div>
          </div>
          <div class="voice-room__status ${voiceLive ? "is-live" : ""}">
            <span></span>
            ${statusText}
          </div>
        </header>

        <div class="voice-room__grid">
          <aside class="voice-room__panel voice-room__setup">
            <div class="voice-room__section-title">Private room</div>
            <label class="voice-room__field">
              <span>Board</span>
              <select
                .value=${this.selectedBoardId}
                ?disabled=${this.loadingBoards}
                @change=${(event: Event) => {
                  this.selectBoardRoom((event.currentTarget as HTMLSelectElement).value);
                }}
              >
                ${this.boardOptions.map(
                  (entry) => html`<option value=${entry.id}>${entry.label}</option>`,
                )}
              </select>
            </label>
            ${board.description
              ? html`<div class="voice-room__hint">${board.description}</div>`
              : nothing}
            <div class="voice-room__section-title">Agents</div>
            ${this.renderAgentSelect(0, "First agent")} ${this.renderAgentSelect(1, "Second agent")}
            <div class="voice-room__section-title">Turn target</div>
            <div class="voice-room__segmented" role="group" aria-label="Turn target">
              ${this.renderTargetButton("first", this.agentById(this.selected[0])?.label ?? "Mark")}
              ${this.renderTargetButton(
                "second",
                this.agentById(this.selected[1])?.label ?? "Lexi",
              )}
              ${this.renderTargetButton("both", "Both")}
            </div>
            <label class="voice-room__toggle">
              <input
                type="checkbox"
                .checked=${this.output === "speak"}
                @change=${(event: Event) => {
                  this.output = (event.currentTarget as HTMLInputElement).checked
                    ? "speak"
                    : "silent";
                }}
              />
              <span
                >${this.output === "speak"
                  ? "Speak typed replies"
                  : "Text only for typed replies"}</span
              >
            </label>
            <div class="voice-room__hint">
              Voice currently routes to ${voiceAgent.label} in ${board.label}. Pick one target
              before joining to switch the live responder.
            </div>
          </aside>

          <main class="voice-room__conversation" aria-live="polite">
            ${this.entries.map((entry) => {
              const speaking = this.speakingEntryIds.has(entry.id);
              return html`
                <article
                  class="voice-room__bubble ${entry.speaker === "You"
                    ? "is-user"
                    : ""} ${entry.error ? "is-error" : ""} ${speaking ? "is-speaking" : ""}"
                >
                  <div class="voice-room__bubble-speaker">${entry.speaker}</div>
                  <div class="voice-room__bubble-text">${entry.text}</div>
                  ${entry.pending || speaking
                    ? html`<div class="voice-room__pending">
                        ${speaking ? "Speaking" : "Waiting"}
                      </div>`
                    : nothing}
                </article>
              `;
            })}
          </main>
        </div>

        <form
          class="voice-room__composer"
          @submit=${(event: Event) => {
            event.preventDefault();
            void this.sendTyped();
          }}
        >
          <button
            class="voice-room__icon-button ${voiceLive ? "is-live" : ""}"
            type="button"
            title=${voiceLive ? "Stop voice" : "Join voice"}
            ?disabled=${!this.connected}
            @click=${() => {
              void this.unlockAudioOutput();
              void this.toggleRealtime();
            }}
          >
            ${voiceLive ? icons.micOff : icons.mic}
          </button>
          <input
            class="voice-room__input"
            autocomplete="off"
            inputmode="text"
            placeholder="Type silently..."
            .value=${this.draft}
            @input=${(event: Event) => {
              this.draft = (event.currentTarget as HTMLInputElement).value;
            }}
          />
          <button
            class="voice-room__icon-button"
            type="button"
            title=${this.output === "speak" ? "Replies will speak" : "Replies stay silent"}
            @click=${() => {
              this.output = this.output === "speak" ? "silent" : "speak";
              if (this.output === "speak") {
                void this.unlockAudioOutput();
              }
            }}
          >
            ${this.output === "speak" ? icons.volume2 : icons.volumeOff}
          </button>
          <button
            class="voice-room__send"
            type="submit"
            title="Send"
            ?disabled=${!this.connected || !this.draft.trim()}
          >
            ${icons.send}
          </button>
        </form>
      </section>
    `;
  }
}

customElements.define("openclaw-voice-room-page", VoiceRoomPage);
