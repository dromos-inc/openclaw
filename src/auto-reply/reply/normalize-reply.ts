// Normalizes raw agent output into sendable reply text and metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import {
  HEARTBEAT_TOKEN,
  isInternalFormattingArtifact,
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveResponsePrefixTemplate,
  type ResponsePrefixContext,
} from "./response-prefix-template.js";

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";

type NormalizeReplyOptions = {
  responsePrefix?: string;
  applyChannelTransforms?: boolean;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

const INTERNAL_ACTIONS = new Set([
  "sessions_spawn",
  "sessions_send",
  "sessions_yield",
  "create_goal",
  "update_goal",
]);

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json|javascript|js)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function isInternalActionJsonText(text: string): boolean {
  const stripped = stripJsonCodeFence(text);
  if (!stripped.startsWith("{") || !stripped.endsWith("}")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const action = (parsed as { action?: unknown }).action;
  return typeof action === "string" && INTERNAL_ACTIONS.has(action);
}

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const applyChannelTransforms = opts.applyChannelTransforms ?? true;
  const hasContent = (text: string | undefined) =>
    hasReplyPayloadContent(
      {
        ...payload,
        text,
      },
      {
        trimText: true,
      },
    );
  const trimmed = normalizeOptionalString(payload.text) ?? "";
  if (!hasContent(trimmed)) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyPayloadText(text, silentToken)) {
    if (!hasContent("")) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
  }
  // Strip NO_REPLY from mixed-content messages (e.g. "😄 NO_REPLY") so the
  // token never leaks to end users.  If stripping leaves nothing, treat it as
  // silent just like the exact-match path above.  (#30916, #30955)
  if (text && !isSilentReplyText(text, silentToken)) {
    const hasLeadingSilentToken = startsWithSilentToken(text, silentToken);
    if (hasLeadingSilentToken) {
      text = stripLeadingSilentToken(text, silentToken);
    }
    if (hasLeadingSilentToken || text.toLowerCase().includes(silentToken.toLowerCase())) {
      text = stripSilentToken(text, silentToken);
      if (!hasContent(text)) {
        opts.onSkip?.("silent");
        return null;
      }
    }
  }
  if (text && !trimmed) {
    // Keep empty text when media exists so media-only replies still send.
    text = "";
  }

  if (text && isInternalActionJsonText(text)) {
    if (!hasContent("")) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
  }

  const shouldStripHeartbeat = opts.stripHeartbeat ?? true;
  if (shouldStripHeartbeat && text?.includes(HEARTBEAT_TOKEN)) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.didStrip) {
      opts.onHeartbeatStrip?.();
    }
    if (stripped.shouldSkip && !hasContent(stripped.text)) {
      opts.onSkip?.("heartbeat");
      return null;
    }
    text = stripped.text;
  }

  if (text && isInternalFormattingArtifact(text) && !hasContent("")) {
    opts.onSkip?.("silent");
    return null;
  }

  if (text) {
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  }
  if (!hasContent(text)) {
    opts.onSkip?.("empty");
    return null;
  }

  let enrichedPayload: ReplyPayload = copyReplyPayloadMetadata(payload, { ...payload, text });
  if (applyChannelTransforms && opts.transformReplyPayload) {
    const transformedPayload = opts.transformReplyPayload(enrichedPayload);
    if (transformedPayload === null) {
      return null;
    }
    enrichedPayload = transformedPayload
      ? copyReplyPayloadMetadata(enrichedPayload, transformedPayload)
      : enrichedPayload;
    text = enrichedPayload.text;
  }

  // Resolve template variables in responsePrefix if context is provided
  const effectivePrefix = opts.responsePrefixContext
    ? resolveResponsePrefixTemplate(opts.responsePrefix, opts.responsePrefixContext)
    : opts.responsePrefix;

  if (
    effectivePrefix &&
    text &&
    text.trim() !== HEARTBEAT_TOKEN &&
    !text.startsWith(effectivePrefix)
  ) {
    text = `${effectivePrefix} ${text}`;
  }

  enrichedPayload = copyReplyPayloadMetadata(enrichedPayload, { ...enrichedPayload, text });
  return enrichedPayload;
}
