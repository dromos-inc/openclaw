// Home-rooted directory browser backing the Control UI workspace-folder picker.
// Read-only listing of child directories, confined to the gateway user's home so
// the RPC never becomes a general filesystem read primitive.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type FsDirEntry,
  type FsDirsListResult,
  validateFsDirsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_DIR_ENTRIES = 500;

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

// Realpath both sides so a symlink cannot walk the browse outside home.
function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function listChildDirectories(
  rootDir: string,
  requested: string | undefined,
): Promise<FsDirsListResult> {
  const root = (await realpathOrNull(rootDir)) ?? rootDir;
  const requestedReal = requested ? await realpathOrNull(path.resolve(requested)) : null;
  // Missing/denied/escaping paths fall back to the root instead of erroring.
  const target = requestedReal && isWithinRoot(root, requestedReal) ? requestedReal : root;

  let dirents: Dirent[] = [];
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch {
    dirents = [];
  }
  // Real directories only; symlinked entries are skipped to keep confinement simple.
  const names = dirents
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const truncated = names.length > MAX_DIR_ENTRIES;
  const entries: FsDirEntry[] = names.slice(0, MAX_DIR_ENTRIES).map((name) => ({
    name,
    path: path.join(target, name),
  }));

  return {
    root,
    path: target,
    // Null at the root so the picker cannot offer navigation above home.
    parent: target === root ? null : path.dirname(target),
    entries,
    ...(truncated ? { truncated } : {}),
  };
}

/** Gateway handler for the home-rooted workspace-folder browser. */
export const fsDirsHandlers: GatewayRequestHandlers = {
  "fs.dirs.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateFsDirsListParams, "fs.dirs.list", respond)) {
      return;
    }
    respond(true, await listChildDirectories(os.homedir(), params.path));
  },
};
