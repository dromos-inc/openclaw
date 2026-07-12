import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/** One child directory in the home-rooted folder browser. */
export const FsDirEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    // Absolute path; the browse root confines it to the gateway user's home.
    path: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Lists immediate child directories of a folder under the browse root. */
export const FsDirsListParamsSchema = Type.Object(
  {
    // Absolute path to list; omitted or outside the root falls back to the root.
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Child directories of one folder plus the breadcrumb parent within the root. */
export const FsDirsListResultSchema = Type.Object(
  {
    root: NonEmptyString,
    path: NonEmptyString,
    // Null when path is the browse root; navigation cannot ascend past it.
    parent: Type.Union([NonEmptyString, Type.Null()]),
    entries: Type.Array(FsDirEntrySchema),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
