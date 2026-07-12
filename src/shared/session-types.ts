/** Agent identity fields returned by gateway session listing APIs. */
export type GatewayAgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

/** Model summary returned for an agent/session row. */
export type GatewayAgentModel = {
  primary?: string;
  fallbacks?: string[];
};

/** Runtime selection metadata for an agent row. */
export type GatewayAgentRuntime = {
  id: string;
  fallback?: "openclaw" | "none";
  source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session-key";
};

/** Thinking-level option exposed to UI clients. */
export type GatewayThinkingLevelOption = {
  id: string;
  label: string;
};

/** Sanitized TTS speaker metadata exposed to UI clients. */
export type GatewayAgentTts = {
  model?: string;
  modelId?: string;
  outputFormat?: string;
  responseFormat?: string;
  speakerVoice?: string;
  speakerVoiceId?: string;
  speed?: number;
  stability?: number;
  similarity?: number;
  similarityBoost?: number;
  style?: number;
  speakerBoost?: boolean;
  useSpeakerBoost?: boolean;
  voice?: string;
  voiceId?: string;
  latencyTier?: number;
  language?: string;
  languageCode?: string;
  normalize?: string;
  applyTextNormalization?: string;
};

/** Common agent row shape used by session list responses. */
export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: GatewayAgentIdentity;
  workspace?: string;
  workspaceGit?: boolean;
  model?: GatewayAgentModel;
  agentRuntime?: GatewayAgentRuntime;
  thinkingLevels?: GatewayThinkingLevelOption[];
  thinkingOptions?: string[];
  thinkingDefault?: string;
  tts?: GatewayAgentTts;
};

/** Generic base for paged session-list responses. */
export type SessionsListResultBase<TDefaults, TRow> = {
  ts: number;
  path: string;
  count: number;
  totalCount?: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  defaults: TDefaults;
  sessions: TRow[];
};

/** Generic base for successful session patch responses. */
export type SessionsPatchResultBase<TEntry> = {
  ok: true;
  path: string;
  key: string;
  entry: TEntry;
};
