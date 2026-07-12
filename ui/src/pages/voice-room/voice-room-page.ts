import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { RealtimeTalkSession, type RealtimeTalkStatus } from "../chat/realtime-talk.ts";

type VoiceRoomAgent = {
  id: string;
  label: string;
  talkVoice?: string;
  configuredVoice?: string;
  configuredSpeech?: VoiceRoomSpeechSettings;
};

type VoiceRoomEntry = {
  id: string;
  speaker: string;
  text: string;
  pending?: boolean;
  error?: boolean;
};

type VoiceRoomTextSegment = {
  kind: "speech" | "action";
  text: string;
};

type VoiceRoomRecordingEntry = {
  id: string;
  speaker: string;
  text: string;
  createdAt: number;
};

type VoiceRoomRecording = {
  id: string;
  label: string;
  roomId: string;
  createdAt: number;
  updatedAt: number;
  entries: VoiceRoomRecordingEntry[];
};

type VoiceRoomVoiceChoice = {
  id: string;
  label: string;
  gender?: "F" | "M";
  description?: string;
};

type VoiceRoomSpeechSettings = {
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  speed?: number;
  stability?: number;
  similarity?: number;
  style?: number;
  speakerBoost?: boolean;
  latencyTier?: number;
  language?: string;
  normalize?: string;
};

type VoiceRoomRoom = {
  id: string;
  label: string;
  description?: string;
};

type VoiceRoomTarget = "first" | "second" | "both";
type VoiceRoomOutput = "silent" | "speak";
type VoiceRoomSpeechState = {
  spokenLength: number;
  queue: string[];
  speaking: boolean;
  idleResolvers: Array<() => void>;
};
type VoiceRoomPendingRun = {
  agent: VoiceRoomAgent;
  entryId: string;
  resolve: () => void;
  speech: VoiceRoomSpeechState;
};

const DEFAULT_AGENTS: VoiceRoomAgent[] = [
  { id: "mark", label: "Mark", talkVoice: "onyx" },
  { id: "rp", label: "Lexi RP", talkVoice: "nova" },
];
const MIN_SPEECH_CHUNK_CHARS = 180;
const MAX_SPEECH_CHUNK_CHARS = 360;
const VOICE_ROOM_RECORDINGS_STORAGE_KEY = "openclaw.voice-room.recordings.v1";
const VOICE_ROOM_PREFS_STORAGE_KEY = "openclaw.voice-room.prefs.v1";
const VOICE_ROOM_ROOMS_STORAGE_KEY = "openclaw.voice-room.rooms.v1";
const VOICE_ROOM_VOICE_CHOICES: VoiceRoomVoiceChoice[] = [
  { id: "alloy", label: "Alloy", gender: "F", description: "Contralto, smokey and husky." },
  { id: "ash", label: "Ash", gender: "M", description: "Scratchy, upbeat baritone." },
  {
    id: "ballad",
    label: "Ballad",
    gender: "M",
    description: "Clear tenor with slight British accent.",
  },
  { id: "coral", label: "Coral", gender: "F", description: "Clear alto or second soprano." },
  { id: "echo", label: "Echo", gender: "M", description: "Warm, energetic first tenor." },
  {
    id: "fable",
    label: "Fable",
    gender: "F",
    description: "Alto with slight English or New Zealand accent.",
  },
  { id: "onyx", label: "Onyx", gender: "M", description: "Bass/baritone, husky, broad range." },
  {
    id: "nova",
    label: "Nova",
    gender: "F",
    description: "Alto, very responsive to voice direction.",
  },
  { id: "sage", label: "Sage", gender: "F", description: "Second soprano, very responsive." },
  { id: "shimmer", label: "Shimmer", gender: "F", description: "Alto or contralto, soothing." },
  {
    id: "verse",
    label: "Verse",
    gender: "M",
    description: "Tenor, very responsive to voice direction.",
  },
];
const VOICE_ROOM_OUTPUT_FORMAT_CHOICES: VoiceRoomVoiceChoice[] = [
  { id: "", label: "Provider default" },
  { id: "mp3", label: "MP3" },
  { id: "mp3_44100_128", label: "MP3 44.1k 128k" },
  { id: "opus_48000_64", label: "Opus 48k 64k" },
  { id: "pcm_44100", label: "PCM 44.1k" },
  { id: "ulaw_8000", label: "u-law 8k" },
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

function buildAgentRoomSessionKey(agentId: string, roomId: string): string {
  return `agent:${sanitizeSessionSegment(agentId, "agent")}:voice-room:room:${sanitizeSessionSegment(
    roomId,
    "default",
  )}`;
}

function normalizeAgentLabel(agent: AgentsListResult["agents"][number]): string {
  return agent.identity?.name?.trim() || agent.name?.trim() || agent.id;
}

function normalizeVoiceId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSpeechVoiceId(value: unknown): string | undefined {
  const voiceId = normalizeVoiceId(value);
  if (!voiceId) {
    return undefined;
  }
  const legacyRealtimeVoiceMap: Record<string, string> = {
    cedar: "onyx",
    marin: "nova",
  };
  return legacyRealtimeVoiceMap[voiceId.toLowerCase()] ?? voiceId;
}

function voiceChoiceLabel(voice: VoiceRoomVoiceChoice): string {
  return voice.gender ? `${voice.label} (${voice.gender})` : voice.label;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function configuredVoiceForAgent(agent: AgentsListResult["agents"][number]): string | undefined {
  const tts = (agent as { tts?: Record<string, unknown> }).tts;
  if (!tts || typeof tts !== "object") {
    return undefined;
  }
  return (
    normalizeVoiceId(tts.speakerVoice) ??
    normalizeVoiceId(tts.voice) ??
    normalizeVoiceId(tts.speakerVoiceId) ??
    normalizeVoiceId(tts.voiceId)
  );
}

function configuredSpeechForAgent(
  agent: AgentsListResult["agents"][number],
): VoiceRoomSpeechSettings | undefined {
  const tts = (agent as { tts?: Record<string, unknown> }).tts;
  if (!tts || typeof tts !== "object") {
    return undefined;
  }
  const voiceId = configuredVoiceForAgent(agent);
  const modelId = normalizeVoiceId(tts.modelId) ?? normalizeVoiceId(tts.model);
  const outputFormat = normalizeVoiceId(tts.outputFormat) ?? normalizeVoiceId(tts.responseFormat);
  const similarity =
    normalizeOptionalNumber(tts.similarity) ?? normalizeOptionalNumber(tts.similarityBoost);
  const speakerBoost =
    normalizeOptionalBoolean(tts.speakerBoost) ?? normalizeOptionalBoolean(tts.useSpeakerBoost);
  const language = normalizeVoiceId(tts.language) ?? normalizeVoiceId(tts.languageCode);
  const normalize = normalizeVoiceId(tts.normalize) ?? normalizeVoiceId(tts.applyTextNormalization);
  const settings: VoiceRoomSpeechSettings = {
    ...(voiceId ? { voiceId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(normalizeOptionalNumber(tts.speed) !== undefined
      ? { speed: normalizeOptionalNumber(tts.speed) }
      : {}),
    ...(normalizeOptionalNumber(tts.stability) !== undefined
      ? { stability: normalizeOptionalNumber(tts.stability) }
      : {}),
    ...(similarity !== undefined ? { similarity } : {}),
    ...(normalizeOptionalNumber(tts.style) !== undefined
      ? { style: normalizeOptionalNumber(tts.style) }
      : {}),
    ...(speakerBoost !== undefined ? { speakerBoost } : {}),
    ...(normalizeOptionalNumber(tts.latencyTier) !== undefined
      ? { latencyTier: normalizeOptionalNumber(tts.latencyTier) }
      : {}),
    ...(language ? { language } : {}),
    ...(normalize ? { normalize } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
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

function createSpeechState(): VoiceRoomSpeechState {
  return {
    spokenLength: 0,
    queue: [],
    speaking: false,
    idleResolvers: [],
  };
}

function findSpeechChunkBoundary(text: string, force: boolean): number {
  if (force) {
    return text.length;
  }
  if (text.length < MIN_SPEECH_CHUNK_CHARS) {
    return 0;
  }

  const search = text.slice(0, Math.min(text.length, MAX_SPEECH_CHUNK_CHARS));
  const boundaryPattern = /[.!?]\s+|\n{2,}|\n/g;
  let boundary = 0;
  for (const match of search.matchAll(boundaryPattern)) {
    const end = match.index + match[0].length;
    if (end >= MIN_SPEECH_CHUNK_CHARS) {
      boundary = end;
    }
  }
  if (boundary > 0) {
    return boundary;
  }

  if (text.length < MAX_SPEECH_CHUNK_CHARS) {
    return 0;
  }
  const whitespace = search.lastIndexOf(" ");
  return whitespace >= MIN_SPEECH_CHUNK_CHARS ? whitespace + 1 : MAX_SPEECH_CHUNK_CHARS;
}

function parseRoleplaySegments(text: string): VoiceRoomTextSegment[] {
  const segments: VoiceRoomTextSegment[] = [];
  const pattern = /\*([^*]+)\*/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ kind: "speech", text: text.slice(cursor, index) });
    }
    segments.push({ kind: "action", text: match[1] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "speech", text: text.slice(cursor) });
  }
  return segments.filter((segment) => segment.text.trim().length > 0);
}

function normalizeSpeechSegmentText(text: string): string {
  return text
    .replace(/(^|\s)["“”]+/g, "$1")
    .replace(/["“”]+(\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function roleplaySpeechText(text: string, narrateActions: boolean): string {
  return parseRoleplaySegments(text)
    .filter((segment) => narrateActions || segment.kind === "speech")
    .map((segment) => normalizeSpeechSegmentText(segment.text))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function readVoiceRoomRecordings(): VoiceRoomRecording[] {
  try {
    const raw = window.localStorage.getItem(VOICE_ROOM_RECORDINGS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((recording): VoiceRoomRecording[] => {
      if (!recording || typeof recording !== "object") {
        return [];
      }
      const record = recording as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const label = typeof record.label === "string" ? record.label : "";
      const roomId =
        typeof record.roomId === "string"
          ? record.roomId
          : typeof record.boardId === "string"
            ? record.boardId
            : "default";
      const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
      const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : createdAt;
      const entries = Array.isArray(record.entries) ? record.entries : [];
      if (!id || !label) {
        return [];
      }
      return [
        {
          id,
          label,
          roomId,
          createdAt,
          updatedAt,
          entries: entries.flatMap((entry): VoiceRoomRecordingEntry[] => {
            if (!entry || typeof entry !== "object") {
              return [];
            }
            const entryRecord = entry as Record<string, unknown>;
            const entryId = typeof entryRecord.id === "string" ? entryRecord.id : "";
            const speaker = typeof entryRecord.speaker === "string" ? entryRecord.speaker : "";
            const entryText = typeof entryRecord.text === "string" ? entryRecord.text : "";
            if (!entryId || !speaker || !entryText.trim()) {
              return [];
            }
            return [
              {
                id: entryId,
                speaker,
                text: entryText,
                createdAt:
                  typeof entryRecord.createdAt === "number" ? entryRecord.createdAt : createdAt,
              },
            ];
          }),
        },
      ];
    });
  } catch {
    return [];
  }
}

function writeVoiceRoomRecordings(recordings: VoiceRoomRecording[]) {
  try {
    window.localStorage.setItem(
      VOICE_ROOM_RECORDINGS_STORAGE_KEY,
      JSON.stringify(recordings.slice(0, 30)),
    );
  } catch {
    // Local storage may be disabled; recording is best-effort UI state.
  }
}

function roomIdFromName(name: string): string {
  return sanitizeSessionSegment(name.toLowerCase(), "room");
}

function readVoiceRoomRooms(): VoiceRoomRoom[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VOICE_ROOM_ROOMS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    const rooms = parsed.flatMap((room): VoiceRoomRoom[] => {
      if (!room || typeof room !== "object") {
        return [];
      }
      const record = room as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const id = typeof record.id === "string" ? record.id.trim() : roomIdFromName(label);
      if (!id || !label) {
        return [];
      }
      return [
        {
          id,
          label,
          ...(typeof record.description === "string" ? { description: record.description } : {}),
        },
      ];
    });
    return mergeDefaultRoom(rooms);
  } catch {
    return mergeDefaultRoom([]);
  }
}

function writeVoiceRoomRooms(rooms: VoiceRoomRoom[]) {
  try {
    window.localStorage.setItem(VOICE_ROOM_ROOMS_STORAGE_KEY, JSON.stringify(rooms));
  } catch {
    // Rooms are optional convenience state.
  }
}

function normalizeSpeechSettings(value: unknown): VoiceRoomSpeechSettings | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const voiceId = normalizeSpeechVoiceId(record.voiceId) ?? normalizeSpeechVoiceId(record.voice);
  const modelId = normalizeVoiceId(record.modelId) ?? normalizeVoiceId(record.model);
  const outputFormat =
    normalizeVoiceId(record.outputFormat) ?? normalizeVoiceId(record.responseFormat);
  const similarity =
    normalizeOptionalNumber(record.similarity) ?? normalizeOptionalNumber(record.similarityBoost);
  const speakerBoost =
    normalizeOptionalBoolean(record.speakerBoost) ??
    normalizeOptionalBoolean(record.useSpeakerBoost);
  const language = normalizeVoiceId(record.language) ?? normalizeVoiceId(record.languageCode);
  const normalize =
    normalizeVoiceId(record.normalize) ?? normalizeVoiceId(record.applyTextNormalization);
  const settings: VoiceRoomSpeechSettings = {
    ...(voiceId ? { voiceId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(normalizeOptionalNumber(record.speed) !== undefined
      ? { speed: normalizeOptionalNumber(record.speed) }
      : {}),
    ...(normalizeOptionalNumber(record.stability) !== undefined
      ? { stability: normalizeOptionalNumber(record.stability) }
      : {}),
    ...(similarity !== undefined ? { similarity } : {}),
    ...(normalizeOptionalNumber(record.style) !== undefined
      ? { style: normalizeOptionalNumber(record.style) }
      : {}),
    ...(speakerBoost !== undefined ? { speakerBoost } : {}),
    ...(normalizeOptionalNumber(record.latencyTier) !== undefined
      ? { latencyTier: normalizeOptionalNumber(record.latencyTier) }
      : {}),
    ...(language ? { language } : {}),
    ...(normalize ? { normalize } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function readVoiceRoomPrefs(): {
  agentSpeechSettings: Record<string, VoiceRoomSpeechSettings>;
  userSpeechSettings: VoiceRoomSpeechSettings;
  narrateActions: boolean;
  selected?: [string, string];
  selectedRoomId?: string;
  target?: VoiceRoomTarget;
  output?: VoiceRoomOutput;
} {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VOICE_ROOM_PREFS_STORAGE_KEY) ?? "{}");
    const legacyAgentVoiceIds =
      parsed.agentVoiceIds && typeof parsed.agentVoiceIds === "object"
        ? Object.fromEntries(
            Object.entries(parsed.agentVoiceIds as Record<string, unknown>).flatMap(
              ([agentId, voiceId]) =>
                typeof voiceId === "string" && voiceId.trim() ? [[agentId, voiceId]] : [],
            ),
          )
        : {};
    const agentSpeechSettings =
      parsed.agentSpeechSettings && typeof parsed.agentSpeechSettings === "object"
        ? Object.fromEntries(
            Object.entries(parsed.agentSpeechSettings as Record<string, unknown>).flatMap(
              ([agentId, value]) => {
                const settings = normalizeSpeechSettings(value);
                return settings ? [[agentId, settings]] : [];
              },
            ),
          )
        : {};
    for (const [agentId, voiceId] of Object.entries(legacyAgentVoiceIds)) {
      const normalizedVoiceId = normalizeSpeechVoiceId(voiceId);
      agentSpeechSettings[agentId] = {
        ...agentSpeechSettings[agentId],
        ...(normalizedVoiceId ? { voiceId: normalizedVoiceId } : {}),
      };
    }
    const legacyUserVoiceId =
      typeof parsed.userVoiceId === "string" && parsed.userVoiceId.trim()
        ? normalizeSpeechVoiceId(parsed.userVoiceId)
        : undefined;
    const userSpeechSettings = {
      ...normalizeSpeechSettings(parsed.userSpeechSettings),
      ...(legacyUserVoiceId ? { voiceId: legacyUserVoiceId } : {}),
    };
    return {
      agentSpeechSettings,
      userSpeechSettings,
      narrateActions: parsed.narrateActions === true,
      ...(Array.isArray(parsed.selected) &&
      typeof parsed.selected[0] === "string" &&
      typeof parsed.selected[1] === "string"
        ? { selected: [parsed.selected[0], parsed.selected[1]] as [string, string] }
        : {}),
      ...(typeof parsed.selectedRoomId === "string" && parsed.selectedRoomId.trim()
        ? { selectedRoomId: parsed.selectedRoomId.trim() }
        : {}),
      ...(parsed.target === "first" || parsed.target === "second" || parsed.target === "both"
        ? { target: parsed.target }
        : {}),
      ...(parsed.output === "silent" || parsed.output === "speak" ? { output: parsed.output } : {}),
    };
  } catch {
    return { agentSpeechSettings: {}, userSpeechSettings: {}, narrateActions: false };
  }
}

function writeVoiceRoomPrefs(prefs: {
  agentSpeechSettings: Record<string, VoiceRoomSpeechSettings>;
  userSpeechSettings: VoiceRoomSpeechSettings;
  narrateActions: boolean;
  selected: [string, string];
  selectedRoomId: string;
  target: VoiceRoomTarget;
  output: VoiceRoomOutput;
}) {
  try {
    window.localStorage.setItem(VOICE_ROOM_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are optional convenience state.
  }
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

function mergeDefaultRoom(rooms: VoiceRoomRoom[]): VoiceRoomRoom[] {
  const byId = new Map(rooms.map((room) => [room.id.toLowerCase(), room]));
  const defaultRoom = byId.get("default") ?? {
    id: "default",
    label: "Default room",
    description: "Private room for uncategorized conversations.",
  };
  return [defaultRoom, ...rooms.filter((room) => room.id.toLowerCase() !== "default")].toSorted(
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
  @state() private loadingRooms = false;
  @state() private agentOptions: VoiceRoomAgent[] = DEFAULT_AGENTS;
  @state() private roomOptions: VoiceRoomRoom[] = mergeDefaultRoom([]);
  @state() private selected: [string, string] = ["mark", "rp"];
  @state() private selectedRoomId = "default";
  @state() private selectedRoomDescriptionDraft = "";
  @state() private newRoomName = "";
  @state() private newRoomDescription = "";
  @state() private target: VoiceRoomTarget = "second";
  @state() private output: VoiceRoomOutput = "silent";
  @state() private draft = "";
  @state() private status: RealtimeTalkStatus = "idle";
  @state() private statusDetail = "";
  @state() private speakingEntryIds = new Set<string>();
  @state() private recordingEnabled = true;
  @state() private recordings: VoiceRoomRecording[] = [];
  @state() private selectedRecordingId = "";
  @state() private replaying = false;
  @state() private speechUnavailableMessage = "";
  @state() private agentSpeechSettings: Record<string, VoiceRoomSpeechSettings> = {};
  @state() private userSpeechSettings: VoiceRoomSpeechSettings = {};
  @state() private narrateActions = false;
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
  private pendingRuns = new Map<string, VoiceRoomPendingRun>();
  private currentRecordingId: string | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.recordings = readVoiceRoomRecordings();
    this.selectedRecordingId = this.recordings[0]?.id ?? "";
    const prefs = readVoiceRoomPrefs();
    this.agentSpeechSettings = prefs.agentSpeechSettings;
    this.userSpeechSettings = prefs.userSpeechSettings;
    this.narrateActions = prefs.narrateActions;
    this.selected = prefs.selected ?? this.selected;
    this.selectedRoomId = prefs.selectedRoomId ?? this.selectedRoomId;
    this.target = prefs.target ?? this.target;
    this.output = prefs.output ?? this.output;
    this.stopGateway = this.context.gateway.subscribe((snapshot) => {
      this.connected = snapshot.connected;
      if (snapshot.client !== this.client) {
        this.stopRealtime();
        this.client = snapshot.client;
        this.speechUnavailableMessage = "";
        this.pendingRuns.clear();
        this.loadAgents();
        this.loadRooms();
      }
    });
    this.stopEvents = this.context.gateway.subscribeEvents((event) =>
      this.handleGatewayEvent(event),
    );
    const snapshot = this.context.gateway.snapshot;
    this.connected = snapshot.connected;
    this.client = snapshot.client;
    this.loadAgents();
    this.loadRooms();
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
          configuredVoice: configuredVoiceForAgent(agent),
          configuredSpeech: configuredSpeechForAgent(agent),
          talkVoice: configuredVoiceForAgent(agent) ?? this.talkVoiceForAgent(agent.id),
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

  private loadRooms() {
    if (this.loadingRooms) {
      return;
    }
    this.loadingRooms = true;
    this.roomOptions = readVoiceRoomRooms();
    if (!this.roomOptions.some((room) => room.id === this.selectedRoomId)) {
      this.selectRoom("default");
    } else {
      this.selectedRoomDescriptionDraft = this.selectedRoom().description ?? "";
    }
    this.loadingRooms = false;
  }

  private talkVoiceForAgent(agentId: string): string | undefined {
    const normalized = agentId.toLowerCase();
    if (normalized === "mark") {
      return "onyx";
    }
    if (isLexiAgentId(normalized)) {
      return "nova";
    }
    return undefined;
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
    const first = this.selectedAgentForSlot(0);
    const second = this.selectedAgentForSlot(1);
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

  private selectedRoom(): VoiceRoomRoom {
    return (
      this.roomOptions.find((room) => room.id === this.selectedRoomId) ??
      this.roomOptions[0] ?? {
        id: "default",
        label: "Default room",
      }
    );
  }

  private agentById(agentId: string): VoiceRoomAgent | undefined {
    return this.agentOptions.find((agent) => agent.id === agentId);
  }

  private selectedAgentForSlot(index: 0 | 1): VoiceRoomAgent {
    return this.agentById(this.selected[index]) ?? DEFAULT_AGENTS[index];
  }

  private currentRoomSessionKey(agentId: string): string {
    return buildAgentRoomSessionKey(agentId, this.selectedRoom().id);
  }

  private selectRoom(roomId: string) {
    if (this.selectedRoomId === roomId) {
      return;
    }
    this.stopRealtime();
    this.pendingRuns.clear();
    this.selectedRoomId = roomId;
    const room = this.roomOptions.find((entry) => entry.id === roomId) ?? {
      id: roomId,
      label: roomId,
    };
    this.selectedRoomDescriptionDraft = room.description ?? "";
    this.entries = [
      {
        id: `welcome-${sanitizeSessionSegment(room.id, "room")}`,
        speaker: "Room",
        text: `${room.label}: private room. Messages here stay in this room-specific agent session.`,
      },
    ];
    this.currentRecordingId = null;
    this.persistVoiceRoomPrefs();
  }

  private createRoom() {
    const label = this.newRoomName.trim();
    if (!label) {
      return;
    }
    const id = roomIdFromName(label);
    const existing = this.roomOptions.find((room) => room.id.toLowerCase() === id.toLowerCase());
    if (existing) {
      this.newRoomName = "";
      this.newRoomDescription = "";
      this.selectRoom(existing.id);
      return;
    }
    const description = this.newRoomDescription;
    const nextRooms = mergeDefaultRoom([
      ...this.roomOptions,
      { id, label, ...(description.trim() ? { description } : {}) },
    ]);
    this.roomOptions = nextRooms;
    writeVoiceRoomRooms(nextRooms);
    this.newRoomName = "";
    this.newRoomDescription = "";
    this.selectRoom(id);
  }

  private selectedRoomDescriptionChanged(): boolean {
    return this.selectedRoomDescriptionDraft !== (this.selectedRoom().description ?? "");
  }

  private saveSelectedRoomDescription() {
    const description = this.selectedRoomDescriptionDraft;
    const roomId = this.selectedRoom().id;
    const nextRooms = mergeDefaultRoom(
      this.roomOptions.map((room) => (room.id === roomId ? { ...room, description } : room)),
    );
    this.roomOptions = nextRooms;
    writeVoiceRoomRooms(nextRooms);
    this.selectedRoomDescriptionDraft = description;
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
    this.recordEntrySnapshot({ id, speaker, text, pending: options.pending, error: options.error });
    return id;
  }

  private updateEntry(id: string, patch: Partial<VoiceRoomEntry>) {
    let updated: VoiceRoomEntry | undefined;
    this.entries = this.entries.map((entry) => {
      if (entry.id !== id) {
        return entry;
      }
      updated = { ...entry, ...patch };
      return updated;
    });
    if (updated) {
      this.recordEntrySnapshot(updated);
    }
  }

  private persistVoiceRoomPrefs() {
    writeVoiceRoomPrefs({
      agentSpeechSettings: this.agentSpeechSettings,
      userSpeechSettings: this.userSpeechSettings,
      narrateActions: this.narrateActions,
      selected: this.selected,
      selectedRoomId: this.selectedRoomId,
      target: this.target,
      output: this.output,
    });
  }

  private effectiveSpeechSettingsForAgent(agent: VoiceRoomAgent): VoiceRoomSpeechSettings {
    return {
      ...agent.configuredSpeech,
      ...(agent.talkVoice ? { voiceId: agent.talkVoice } : {}),
      ...this.agentSpeechSettings[agent.id],
    };
  }

  private roleplayVoiceForAgent(agent: VoiceRoomAgent): string | undefined {
    return this.effectiveSpeechSettingsForAgent(agent).voiceId || VOICE_ROOM_VOICE_CHOICES[0]?.id;
  }

  private configuredSpeechSettingsForAgent(agent: VoiceRoomAgent): VoiceRoomSpeechSettings {
    return {
      ...agent.configuredSpeech,
      ...(agent.configuredVoice ? { voiceId: agent.configuredVoice } : {}),
      ...(agent.talkVoice ? { voiceId: agent.talkVoice } : {}),
    };
  }

  private setAgentSpeechSettings(agentId: string, patch: VoiceRoomSpeechSettings) {
    const agent = this.agentById(agentId);
    const configured = agent ? this.configuredSpeechSettingsForAgent(agent) : {};
    const current = this.agentSpeechSettings[agentId] ?? {};
    const merged = normalizeSpeechSettings({ ...current, ...patch }) ?? {};
    const nextSettings: VoiceRoomSpeechSettings = {};
    for (const [key, value] of Object.entries(merged) as Array<
      [keyof VoiceRoomSpeechSettings, VoiceRoomSpeechSettings[keyof VoiceRoomSpeechSettings]]
    >) {
      if (value !== undefined && value !== configured[key]) {
        nextSettings[key] = value as never;
      }
    }
    const next = { ...this.agentSpeechSettings };
    if (Object.keys(nextSettings).length === 0) {
      delete next[agentId];
    } else {
      next[agentId] = nextSettings;
    }
    this.agentSpeechSettings = next;
    this.persistVoiceRoomPrefs();
  }

  private setUserSpeechSettings(patch: VoiceRoomSpeechSettings) {
    this.userSpeechSettings =
      normalizeSpeechSettings({ ...this.userSpeechSettings, ...patch }) ?? {};
    this.persistVoiceRoomPrefs();
  }

  private userReplayVoice(): string | undefined {
    return this.userSpeechSettings.voiceId || VOICE_ROOM_VOICE_CHOICES[0]?.id;
  }

  private speechControlsDisabled(): boolean {
    return !this.connected || Boolean(this.speechUnavailableMessage) || this.replaying;
  }

  private speechErrorMessage(error: unknown): string {
    const message = String(error);
    if (message.includes("talk provider not configured")) {
      return "Talk provider is not configured on this gateway.";
    }
    return message;
  }

  private markSpeechUnavailable(error: unknown): string {
    const message = this.speechErrorMessage(error);
    if (message.includes("Talk provider is not configured")) {
      this.speechUnavailableMessage = message;
    }
    return message;
  }

  private roomContextPrompt(room: VoiceRoomRoom): string {
    const description = room.description?.trim();
    return description
      ? `[Private room: ${room.label} (${room.id})]\nRoom description:\n${description}\n`
      : `[Private room: ${room.label} (${room.id})]`;
  }

  private renderRoomDescription(description: string | undefined) {
    const source = description?.trim();
    if (!source) {
      return nothing;
    }
    return html`<div class="voice-room__room-description sidebar-markdown">
      ${unsafeHTML(toSanitizedMarkdownHtml(source))}
    </div>`;
  }

  private currentRecording(): VoiceRoomRecording {
    const now = Date.now();
    if (this.currentRecordingId) {
      const existing = this.recordings.find(
        (recording) => recording.id === this.currentRecordingId,
      );
      if (existing) {
        return existing;
      }
    }
    const room = this.selectedRoom();
    const created: VoiceRoomRecording = {
      id: generateUUID(),
      label: `${room.label} ${new Date(now).toLocaleString()}`,
      roomId: room.id,
      createdAt: now,
      updatedAt: now,
      entries: [],
    };
    this.currentRecordingId = created.id;
    this.recordings = [created, ...this.recordings].slice(0, 30);
    this.selectedRecordingId = created.id;
    return created;
  }

  private recordEntrySnapshot(entry: VoiceRoomEntry) {
    if (
      !this.recordingEnabled ||
      entry.speaker === "Room" ||
      entry.pending ||
      entry.error ||
      !entry.text.trim()
    ) {
      return;
    }
    const recording = this.currentRecording();
    const now = Date.now();
    const nextEntry: VoiceRoomRecordingEntry = {
      id: entry.id,
      speaker: entry.speaker,
      text: entry.text,
      createdAt: recording.entries.find((candidate) => candidate.id === entry.id)?.createdAt ?? now,
    };
    const nextRecording = {
      ...recording,
      updatedAt: now,
      entries: [
        ...recording.entries.filter((candidate) => candidate.id !== entry.id),
        nextEntry,
      ].toSorted((left, right) => left.createdAt - right.createdAt),
    };
    this.recordings = [
      nextRecording,
      ...this.recordings.filter((candidate) => candidate.id !== nextRecording.id),
    ].slice(0, 30);
    writeVoiceRoomRecordings(this.recordings);
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
        voice: this.roleplayVoiceForAgent(agent),
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
    const room = this.selectedRoom();
    for (const agent of this.selectedAgents()) {
      await this.sendTypedToAgent(client, agent, room, message);
    }
  }

  private async sendTypedToAgent(
    client: GatewayBrowserClient,
    agent: VoiceRoomAgent,
    room: VoiceRoomRoom,
    message: string,
  ) {
    const runId = generateUUID();
    const entryId = this.appendEntry(agent.label, "Thinking...", { pending: true });
    let resolvePending: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    this.pendingRuns.set(runId, {
      agent,
      entryId,
      resolve: resolvePending,
      speech: createSpeechState(),
    });
    try {
      await client.request("chat.send", {
        sessionKey: this.currentRoomSessionKey(agent.id),
        message: `${this.roomContextPrompt(room)}\n${message}`,
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
      this.enqueueSpeechFromText(pending, text, false);
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

  private async finishPendingRun(pending: VoiceRoomPendingRun, text: string) {
    try {
      if (this.output === "speak" && text) {
        await this.enqueueSpeechFromText(pending, text, true);
      }
    } finally {
      pending.resolve();
    }
  }

  private enqueueSpeechFromText(
    pending: VoiceRoomPendingRun,
    text: string,
    force: boolean,
  ): Promise<void> {
    if (this.output !== "speak") {
      return Promise.resolve();
    }
    const speakableText = roleplaySpeechText(text, this.narrateActions);
    const speech = pending.speech;
    while (speech.spokenLength < speakableText.length) {
      const remaining = speakableText.slice(speech.spokenLength);
      const boundary = findSpeechChunkBoundary(remaining, force);
      if (boundary <= 0) {
        break;
      }
      const rawChunk = remaining.slice(0, boundary);
      speech.spokenLength += rawChunk.length;
      const chunk = rawChunk.trim();
      if (chunk) {
        speech.queue.push(chunk);
      }
      if (!force) {
        break;
      }
    }
    void this.drainSpeechQueue(pending);
    if (!force) {
      return Promise.resolve();
    }
    return this.waitForSpeechIdle(speech);
  }

  private async drainSpeechQueue(pending: VoiceRoomPendingRun) {
    const speech = pending.speech;
    if (speech.speaking) {
      return;
    }
    speech.speaking = true;
    try {
      while (speech.queue.length > 0) {
        const chunk = speech.queue.shift();
        if (chunk) {
          await this.speak(pending.agent, chunk, pending.entryId);
        }
      }
    } finally {
      speech.speaking = false;
      if (speech.queue.length > 0) {
        void this.drainSpeechQueue(pending);
      } else {
        for (const resolve of speech.idleResolvers.splice(0)) {
          resolve();
        }
      }
    }
  }

  private waitForSpeechIdle(speech: VoiceRoomSpeechState): Promise<void> {
    if (!speech.speaking && speech.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      speech.idleResolvers.push(resolve);
    });
  }

  private async speak(agent: VoiceRoomAgent, text: string, entryId?: string) {
    const settings = this.effectiveSpeechSettingsForAgent(agent);
    await this.speakLine({
      speaker: agent.label,
      text,
      agentId: agent.id,
      settings,
      entryId,
    });
  }

  private async speakLine(params: {
    speaker: string;
    text: string;
    agentId?: string;
    settings?: VoiceRoomSpeechSettings;
    entryId?: string;
  }) {
    const client = this.client;
    if (!client || this.speechUnavailableMessage) {
      return;
    }
    if (params.entryId) {
      this.setEntrySpeaking(params.entryId, true);
    }
    try {
      const result = await client.request<{ audioBase64?: string; mimeType?: string }>(
        "talk.speak",
        {
          text: params.text,
          agentId: params.agentId,
          ...this.speechRequestParams(params.settings),
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
      const message = this.markSpeechUnavailable(error);
      if (!this.entries.some((entry) => entry.error && entry.text.includes(message))) {
        this.appendEntry("Voice", `Could not speak ${params.speaker}: ${message}`, {
          error: true,
        });
      }
    } finally {
      if (params.entryId) {
        this.setEntrySpeaking(params.entryId, false);
      }
    }
  }

  private speechRequestParams(settings: VoiceRoomSpeechSettings | undefined) {
    return {
      ...(settings?.voiceId ? { voiceId: settings.voiceId } : {}),
      ...(settings?.modelId ? { modelId: settings.modelId } : {}),
      ...(settings?.outputFormat ? { outputFormat: settings.outputFormat } : {}),
      ...(settings?.speed !== undefined ? { speed: settings.speed } : {}),
      ...(settings?.stability !== undefined ? { stability: settings.stability } : {}),
      ...(settings?.similarity !== undefined ? { similarity: settings.similarity } : {}),
      ...(settings?.style !== undefined ? { style: settings.style } : {}),
      ...(settings?.speakerBoost !== undefined ? { speakerBoost: settings.speakerBoost } : {}),
      ...(settings?.latencyTier !== undefined ? { latencyTier: settings.latencyTier } : {}),
      ...(settings?.language ? { language: settings.language } : {}),
      ...(settings?.normalize ? { normalize: settings.normalize } : {}),
    };
  }

  private canPlayEntry(entry: VoiceRoomEntry): boolean {
    return (
      entry.speaker !== "Room" &&
      !entry.pending &&
      !entry.error &&
      Boolean(roleplaySpeechText(entry.text, this.narrateActions))
    );
  }

  private async playEntry(entry: VoiceRoomEntry) {
    if (!this.canPlayEntry(entry) || this.speechControlsDisabled()) {
      return;
    }
    try {
      await this.unlockAudioOutput();
    } catch (error) {
      this.appendEntry("Voice", `Could not unlock browser audio: ${String(error)}`, {
        error: true,
      });
      return;
    }
    const text = roleplaySpeechText(entry.text, this.narrateActions);
    const agent = this.agentOptions.find((candidate) => candidate.label === entry.speaker);
    const isUser = entry.speaker === "You";
    await this.speakLine({
      speaker: entry.speaker,
      text,
      agentId: isUser ? undefined : agent?.id,
      settings: isUser
        ? this.userSpeechSettings
        : agent
          ? this.effectiveSpeechSettingsForAgent(agent)
          : {},
      entryId: entry.id,
    });
  }

  private async replayRecording(recording: VoiceRoomRecording | undefined) {
    if (!recording || this.replaying || this.speechUnavailableMessage) {
      return;
    }
    try {
      await this.unlockAudioOutput();
    } catch (error) {
      this.appendEntry("Voice", `Could not unlock browser audio: ${String(error)}`, {
        error: true,
      });
      return;
    }
    this.replaying = true;
    try {
      for (const entry of recording.entries) {
        const text = roleplaySpeechText(entry.text, this.narrateActions);
        if (!text) {
          continue;
        }
        const agent = this.agentOptions.find((candidate) => candidate.label === entry.speaker);
        const isUser = entry.speaker === "You";
        await this.speakLine({
          speaker: entry.speaker,
          text,
          agentId: isUser ? undefined : agent?.id,
          settings: isUser
            ? this.userSpeechSettings
            : agent
              ? this.effectiveSpeechSettingsForAgent(agent)
              : {},
        });
      }
    } finally {
      this.replaying = false;
    }
  }

  private replayCurrentRoom() {
    const recording =
      this.recordings.find((candidate) => candidate.id === this.currentRecordingId) ??
      ({
        id: "current",
        label: "Current room",
        roomId: this.selectedRoom().id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entries: this.entries
          .filter((entry) => entry.speaker !== "Room" && !entry.pending && !entry.error)
          .map((entry, index) => ({
            id: entry.id,
            speaker: entry.speaker,
            text: entry.text,
            createdAt: Date.now() + index,
          })),
      } satisfies VoiceRoomRecording);
    void this.replayRecording(recording);
  }

  private replaySelectedRecording() {
    void this.replayRecording(
      this.recordings.find((recording) => recording.id === this.selectedRecordingId),
    );
  }

  private async demoAgentVoice(agent: VoiceRoomAgent) {
    try {
      await this.unlockAudioOutput();
    } catch (error) {
      this.appendEntry("Voice", `Could not unlock browser audio: ${String(error)}`, {
        error: true,
      });
      return;
    }
    await this.speakLine({
      speaker: `${agent.label} voice demo`,
      text: `This is ${agent.label}'s selected voice.`,
      agentId: agent.id,
      settings: this.effectiveSpeechSettingsForAgent(agent),
    });
  }

  private async demoUserVoice() {
    try {
      await this.unlockAudioOutput();
    } catch (error) {
      this.appendEntry("Voice", `Could not unlock browser audio: ${String(error)}`, {
        error: true,
      });
      return;
    }
    await this.speakLine({
      speaker: "Your voice demo",
      text: "This is the selected voice for your replay lines.",
      settings: this.userSpeechSettings,
    });
  }

  private renderSpeechControls(params: {
    label: string;
    settings: VoiceRoomSpeechSettings;
    disabled?: boolean;
    demo: () => void;
    onChange: (patch: VoiceRoomSpeechSettings) => void;
  }) {
    const voiceId = params.settings.voiceId ?? "";
    const outputFormat = params.settings.outputFormat ?? "";
    const hasCurrentVoice = VOICE_ROOM_VOICE_CHOICES.some((voice) => voice.id === voiceId);
    const hasCurrentOutputFormat = VOICE_ROOM_OUTPUT_FORMAT_CHOICES.some(
      (format) => format.id === outputFormat,
    );
    return html`
      <div class="voice-room__speech-controls">
        <div class="voice-room__speech-title">
          <span>${params.label}</span>
          <button
            class="voice-room__demo-button"
            type="button"
            title="Play voice demo"
            ?disabled=${params.disabled || this.speechControlsDisabled()}
            @click=${() => {
              params.demo();
            }}
          >
            ${icons.volume2}
          </button>
        </div>
        <label class="voice-room__field">
          <span>Voice</span>
          <select
            .value=${voiceId}
            ?disabled=${params.disabled}
            @change=${(event: Event) => {
              params.onChange({ voiceId: (event.currentTarget as HTMLSelectElement).value });
            }}
          >
            ${voiceId && !hasCurrentVoice
              ? html`<option value=${voiceId}>${voiceId}</option>`
              : nothing}
            ${VOICE_ROOM_VOICE_CHOICES.map(
              (voice) => html`
                <option value=${voice.id} title=${voice.description ?? ""}>
                  ${voiceChoiceLabel(voice)}
                </option>
              `,
            )}
          </select>
        </label>
        <div class="voice-room__speech-two-up">
          <label class="voice-room__field">
            <span>Model</span>
            <input
              type="text"
              autocomplete="off"
              placeholder="Provider default"
              .value=${params.settings.modelId ?? ""}
              @input=${(event: Event) => {
                params.onChange({
                  modelId: (event.currentTarget as HTMLInputElement).value.trim() || undefined,
                });
              }}
            />
          </label>
          <label class="voice-room__field">
            <span>Format</span>
            <select
              .value=${outputFormat}
              @change=${(event: Event) => {
                params.onChange({
                  outputFormat: (event.currentTarget as HTMLSelectElement).value || undefined,
                });
              }}
            >
              ${outputFormat && !hasCurrentOutputFormat
                ? html`<option value=${outputFormat}>${outputFormat}</option>`
                : nothing}
              ${VOICE_ROOM_OUTPUT_FORMAT_CHOICES.map(
                (format) => html`<option value=${format.id}>${format.label}</option>`,
              )}
            </select>
          </label>
        </div>
        ${this.renderSpeechNumberControl({
          label: "Speed",
          value: params.settings.speed ?? 1,
          min: 0.5,
          max: 2,
          step: 0.05,
          onChange: (speed) => params.onChange({ speed }),
        })}
        <div class="voice-room__speech-two-up">
          ${this.renderSpeechNumberControl({
            label: "Stability",
            value: params.settings.stability ?? 0.5,
            min: 0,
            max: 1,
            step: 0.05,
            onChange: (stability) => params.onChange({ stability }),
          })}
          ${this.renderSpeechNumberControl({
            label: "Similarity",
            value: params.settings.similarity ?? 0.75,
            min: 0,
            max: 1,
            step: 0.05,
            onChange: (similarity) => params.onChange({ similarity }),
          })}
        </div>
        <div class="voice-room__speech-two-up">
          ${this.renderSpeechNumberControl({
            label: "Style",
            value: params.settings.style ?? 0,
            min: 0,
            max: 1,
            step: 0.05,
            onChange: (style) => params.onChange({ style }),
          })}
          <label class="voice-room__field">
            <span>Latency tier</span>
            <input
              type="number"
              min="0"
              step="1"
              placeholder="Default"
              .value=${params.settings.latencyTier?.toString() ?? ""}
              @input=${(event: Event) => {
                const value = Number((event.currentTarget as HTMLInputElement).value);
                params.onChange({ latencyTier: Number.isFinite(value) ? value : undefined });
              }}
            />
          </label>
        </div>
        <div class="voice-room__speech-two-up">
          <label class="voice-room__field">
            <span>Language</span>
            <input
              type="text"
              autocomplete="off"
              placeholder="Default"
              .value=${params.settings.language ?? ""}
              @input=${(event: Event) => {
                params.onChange({
                  language: (event.currentTarget as HTMLInputElement).value.trim() || undefined,
                });
              }}
            />
          </label>
          <label class="voice-room__field">
            <span>Normalize</span>
            <input
              type="text"
              autocomplete="off"
              placeholder="auto, on, off"
              .value=${params.settings.normalize ?? ""}
              @input=${(event: Event) => {
                params.onChange({
                  normalize: (event.currentTarget as HTMLInputElement).value.trim() || undefined,
                });
              }}
            />
          </label>
        </div>
        <label class="voice-room__toggle voice-room__toggle--compact">
          <input
            type="checkbox"
            .checked=${params.settings.speakerBoost === true}
            @change=${(event: Event) => {
              params.onChange({
                speakerBoost: (event.currentTarget as HTMLInputElement).checked,
              });
            }}
          />
          <span>Speaker boost</span>
        </label>
      </div>
    `;
  }

  private renderSpeechNumberControl(params: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
  }) {
    return html`
      <label class="voice-room__field">
        <span>${params.label}: ${params.value.toFixed(2)}</span>
        <input
          type="range"
          min=${params.min.toString()}
          max=${params.max.toString()}
          step=${params.step.toString()}
          .value=${params.value.toString()}
          @input=${(event: Event) => {
            const value = Number((event.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(value)) {
              params.onChange(value);
            }
          }}
        />
      </label>
    `;
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
            this.persistVoiceRoomPrefs();
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
          this.persistVoiceRoomPrefs();
        }}
      >
        ${label}
      </button>
    `;
  }

  private renderRoleplayText(text: string) {
    return parseRoleplaySegments(text).map((segment) =>
      segment.kind === "action"
        ? html`<em class="voice-room__action">*${segment.text.trim()}*</em>`
        : html`<span>${segment.text}</span>`,
    );
  }

  override render() {
    const voiceAgent = this.activeVoiceAgent();
    const room = this.selectedRoom();
    const voiceLive = this.realtime !== null;
    const selectedRecording = this.recordings.find(
      (recording) => recording.id === this.selectedRecordingId,
    );
    const statusText =
      this.status === "idle"
        ? "Ready"
        : this.statusDetail || this.status[0].toUpperCase() + this.status.slice(1);
    return html`
      <section class="voice-room">
        <header class="voice-room__header">
          <div>
            <div class="page-title">Voice Room</div>
            <div class="page-sub">${room.label}: private room with voice and silent text.</div>
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
              <span>Room</span>
              <select
                .value=${this.selectedRoomId}
                ?disabled=${this.loadingRooms}
                @change=${(event: Event) => {
                  this.selectRoom((event.currentTarget as HTMLSelectElement).value);
                }}
              >
                ${this.roomOptions.map(
                  (entry) => html`<option value=${entry.id}>${entry.label}</option>`,
                )}
              </select>
            </label>
            ${this.renderRoomDescription(room.description)}
            <label class="voice-room__field">
              <span>Room description</span>
              <div class="voice-room__field-row voice-room__field-row--top">
                <textarea
                  rows="4"
                  placeholder="Markdown supported"
                  .value=${this.selectedRoomDescriptionDraft}
                  @input=${(event: Event) => {
                    this.selectedRoomDescriptionDraft = (
                      event.currentTarget as HTMLTextAreaElement
                    ).value;
                  }}
                ></textarea>
                <button
                  class="voice-room__create-button"
                  type="button"
                  title="Save room description"
                  ?disabled=${!this.selectedRoomDescriptionChanged()}
                  @click=${() => {
                    this.saveSelectedRoomDescription();
                  }}
                >
                  ${icons.check}
                  <span>Save</span>
                </button>
              </div>
            </label>
            <form
              class="voice-room__room-create"
              @submit=${(event: Event) => {
                event.preventDefault();
                this.createRoom();
              }}
            >
              <label class="voice-room__field">
                <span>New room</span>
                <div class="voice-room__field-row">
                  <input
                    type="text"
                    autocomplete="off"
                    placeholder="Room name"
                    .value=${this.newRoomName}
                    @input=${(event: Event) => {
                      this.newRoomName = (event.currentTarget as HTMLInputElement).value;
                    }}
                  />
                  <button
                    class="voice-room__create-button"
                    type="submit"
                    title="Create room"
                    ?disabled=${!this.newRoomName.trim()}
                  >
                    ${icons.plus}
                    <span>Create</span>
                  </button>
                </div>
                <textarea
                  rows="3"
                  placeholder="Optional Markdown description"
                  .value=${this.newRoomDescription}
                  @input=${(event: Event) => {
                    this.newRoomDescription = (event.currentTarget as HTMLTextAreaElement).value;
                  }}
                ></textarea>
              </label>
            </form>
            <div class="voice-room__section-title">Agents</div>
            ${this.renderAgentSelect(0, "First agent")} ${this.renderAgentSelect(1, "Second agent")}
            <div class="voice-room__section-title">Turn target</div>
            <div class="voice-room__segmented" role="group" aria-label="Turn target">
              ${this.renderTargetButton("first", this.selectedAgentForSlot(0).label)}
              ${this.renderTargetButton("second", this.selectedAgentForSlot(1).label)}
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
                  this.persistVoiceRoomPrefs();
                }}
              />
              <span
                >${this.output === "speak"
                  ? "Speak typed replies"
                  : "Text only for typed replies"}</span
              >
            </label>
            <div class="voice-room__hint">
              Voice currently routes to ${voiceAgent.label} in ${room.label}. Pick one target before
              joining to switch the live responder.
              ${this.roleplayVoiceForAgent(voiceAgent)
                ? html`Voice: ${this.roleplayVoiceForAgent(voiceAgent)}.`
                : html`Using the configured Talk voice.`}
            </div>
            <div class="voice-room__section-title">Speech</div>
            ${this.renderSpeechControls({
              label: this.selectedAgentForSlot(0).label,
              settings: this.effectiveSpeechSettingsForAgent(this.selectedAgentForSlot(0)),
              demo: () => {
                void this.demoAgentVoice(this.selectedAgentForSlot(0));
              },
              onChange: (patch) => {
                this.setAgentSpeechSettings(this.selected[0], patch);
              },
            })}
            ${this.selected[1] !== this.selected[0]
              ? this.renderSpeechControls({
                  label: this.selectedAgentForSlot(1).label,
                  settings: this.effectiveSpeechSettingsForAgent(this.selectedAgentForSlot(1)),
                  demo: () => {
                    void this.demoAgentVoice(this.selectedAgentForSlot(1));
                  },
                  onChange: (patch) => {
                    this.setAgentSpeechSettings(this.selected[1], patch);
                  },
                })
              : nothing}
            <label class="voice-room__toggle">
              <input
                type="checkbox"
                .checked=${this.narrateActions}
                @change=${(event: Event) => {
                  this.narrateActions = (event.currentTarget as HTMLInputElement).checked;
                  this.persistVoiceRoomPrefs();
                }}
              />
              <span>${this.narrateActions ? "Narrate action beats" : "Skip action beats"}</span>
            </label>
            ${this.renderSpeechControls({
              label: "Your replay",
              settings: {
                voiceId: this.userReplayVoice(),
                ...this.userSpeechSettings,
              },
              demo: () => {
                void this.demoUserVoice();
              },
              onChange: (patch) => {
                this.setUserSpeechSettings(patch);
              },
            })}
            <div class="voice-room__section-title">Replay</div>
            ${this.speechUnavailableMessage
              ? html`<div class="voice-room__speech-warning" role="status">
                  ${this.speechUnavailableMessage}
                </div>`
              : nothing}
            <label class="voice-room__toggle">
              <input
                type="checkbox"
                .checked=${this.recordingEnabled}
                @change=${(event: Event) => {
                  this.recordingEnabled = (event.currentTarget as HTMLInputElement).checked;
                }}
              />
              <span>${this.recordingEnabled ? "Recording room turns" : "Recording paused"}</span>
            </label>
            <div class="voice-room__replay-actions">
              <button
                class="voice-room__mini-button"
                type="button"
                ?disabled=${this.speechControlsDisabled() || this.entries.length <= 1}
                @click=${() => this.replayCurrentRoom()}
              >
                Replay current
              </button>
              <button
                class="voice-room__mini-button"
                type="button"
                ?disabled=${this.speechControlsDisabled() || !selectedRecording}
                @click=${() => this.replaySelectedRecording()}
              >
                ${this.replaying ? "Replaying" : "Replay saved"}
              </button>
            </div>
            <label class="voice-room__field">
              <span>Saved session</span>
              <select
                .value=${this.selectedRecordingId}
                ?disabled=${this.recordings.length === 0}
                @change=${(event: Event) => {
                  this.selectedRecordingId = (event.currentTarget as HTMLSelectElement).value;
                }}
              >
                ${this.recordings.length === 0
                  ? html`<option value="">No recordings yet</option>`
                  : this.recordings.map(
                      (recording) =>
                        html`<option value=${recording.id}>${recording.label}</option>`,
                    )}
              </select>
            </label>
          </aside>

          <main class="voice-room__conversation" aria-live="polite">
            ${this.entries.map((entry) => {
              const speaking = this.speakingEntryIds.has(entry.id);
              const canPlay = this.canPlayEntry(entry);
              return html`
                <article
                  class="voice-room__bubble ${entry.speaker === "You"
                    ? "is-user"
                    : ""} ${entry.error ? "is-error" : ""} ${speaking ? "is-speaking" : ""}"
                >
                  <div class="voice-room__bubble-header">
                    <div class="voice-room__bubble-speaker">${entry.speaker}</div>
                    ${canPlay
                      ? html`<button
                          class="voice-room__bubble-play"
                          type="button"
                          title="Play this line"
                          ?disabled=${this.speechControlsDisabled() || speaking}
                          @click=${() => {
                            void this.playEntry(entry);
                          }}
                        >
                          ${speaking ? icons.volume2 : icons.play}
                        </button>`
                      : nothing}
                  </div>
                  <div class="voice-room__bubble-text">${this.renderRoleplayText(entry.text)}</div>
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
