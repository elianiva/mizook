import { clipToolOutput } from "@mizook/memory";
import { Effect, Schema } from "effect";
import { KIND_TYPES } from "./artifact-render.ts";
import { Artifacts } from "./artifacts.ts";
import { ToolError } from "./errors.ts";
import { Host } from "./host.ts";
import { defineTool, described } from "./tool.ts";

export const ArtifactPublishArgs = Schema.Struct({
  name: described(
    Schema.String,
    "File name: lowercase letters, digits, dots and dashes. Publishing the same name again adds a version; the link stays the same.",
  ),
  kind: Schema.optionalKey(
    described(
      Schema.Literals(["html", "markdown", "table", "chart"]),
      "html (default): your own page. markdown: a document, drawn in our design. table: JSON {title, description, columns, rows}, drawn as a sortable, filterable table. chart: JSON {type: bar|line|pie|doughnut|radar, title, labels, datasets: [{label, data}]}.",
    ),
  ),
  content: described(
    Schema.String,
    "The whole file: HTML, markdown, or the JSON of a table or chart.",
  ),
  content_type: Schema.optionalKey(
    described(Schema.String, "Only for other files (svg, json, csv, text): their MIME type."),
  ),
  expires_in_hours: Schema.optionalKey(
    described(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      "Take the link down after this many hours. Leave it out for a page that stays.",
    ),
  ),
});

export const ArtifactDataArgs = Schema.Struct({
  name: described(Schema.String, "The artifact's name."),
  action: described(
    Schema.Literals(["list", "get", "set", "delete"]),
    "list: everything the page saved. get / set / delete: one key.",
  ),
  key: Schema.optionalKey(described(Schema.String, "Letters, digits, dots, dashes, up to 64.")),
  value: Schema.optionalKey(described(Schema.String, "set: the value, as JSON text.")),
});

export const ArtifactHistoryArgs = Schema.Struct({
  name: described(Schema.String, "The artifact's name."),
});

export const ArtifactRestoreArgs = Schema.Struct({
  name: described(Schema.String, "The artifact's name."),
  version: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "Which version, from artifacts.history.",
  ),
});

export const ArtifactDeleteArgs = Schema.Struct({
  name: described(Schema.String, "The artifact's name, from artifacts.list."),
});

const channel = Host.use((host) => Effect.succeed(host.self.doName));

export const artifactTools = [
  defineTool({
    name: "artifact_publish",
    path: "artifacts.publish",
    description:
      "Publish a page or file and get a link. Pick a kind: markdown for documents, table and chart for data (drawn for you), html for your own interactive page. The page runs sandboxed: scripts work, but it cannot reach any account or other page.",
    args: ArtifactPublishArgs,
    run: (a) =>
      Effect.gen(function* () {
        const contentType = a.content_type ?? KIND_TYPES[a.kind ?? "html"];
        const made = yield* (yield* Artifacts).publish(
          yield* channel,
          a.name,
          a.content,
          contentType,
          a.expires_in_hours ? { expiresInHours: a.expires_in_hours } : {},
        );
        return `Published v${made.version}: ${made.url}`;
      }),
  }),
  defineTool({
    name: "artifact_data",
    path: "artifacts.data",
    description:
      "Read or write the data an artifact's page shows through mizook.data (a tracker's entries, a checklist's state). Only you can write it; the page reads it.",
    args: ArtifactDataArgs,
    run: (a) =>
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        const need = (v: string | undefined, what: string) =>
          v === undefined
            ? Effect.fail(new ToolError({ reason: `${a.action} needs ${what}` }))
            : Effect.succeed(v);
        switch (a.action) {
          case "list": {
            const all = yield* artifacts.data.list(a.name);
            return Object.keys(all).length === 0
              ? "No data saved."
              : clipToolOutput(JSON.stringify(all, null, 1));
          }
          case "get":
            return (
              (yield* artifacts.data.get(a.name, yield* need(a.key, "`key`"))) ?? "No such key."
            );
          case "set":
            yield* artifacts.data.set(
              a.name,
              yield* need(a.key, "`key`"),
              yield* need(a.value, "`value`"),
            );
            return "Saved.";
          case "delete":
            yield* artifacts.data.delete(a.name, yield* need(a.key, "`key`"));
            return "Deleted.";
        }
      }),
  }),
  defineTool({
    name: "artifact_history",
    path: "artifacts.history",
    description: "List the versions kept of an artifact.",
    args: ArtifactHistoryArgs,
    run: (a) =>
      Effect.gen(function* () {
        const versions = yield* (yield* Artifacts).history(yield* channel, a.name);
        return versions.length === 0
          ? `No versions of ${a.name}.`
          : `${a.name}: versions ${versions.join(", ")}.`;
      }),
  }),
  defineTool({
    name: "artifact_restore",
    path: "artifacts.restore",
    description: "Publish an earlier version of an artifact again, as a new version.",
    args: ArtifactRestoreArgs,
    run: (a) =>
      Effect.gen(function* () {
        const made = yield* (yield* Artifacts).restore(yield* channel, a.name, a.version);
        return `Restored as v${made.version}: ${made.url}`;
      }),
  }),
  defineTool({
    name: "artifact_list",
    path: "artifacts.list",
    description: "List published artifacts with their links.",
    args: Schema.Struct({}),
    run: () =>
      Artifacts.use((artifacts) =>
        Effect.map(artifacts.list, (all) =>
          all.length === 0
            ? "No artifacts."
            : all.map((a) => `${a.name} v${a.version} ${a.url}`).join("\n"),
        ),
      ),
  }),
  defineTool({
    name: "artifact_delete",
    path: "artifacts.delete",
    description: "Take an artifact's link down.",
    args: ArtifactDeleteArgs,
    run: (a) =>
      Effect.gen(function* () {
        return (yield* (yield* Artifacts).remove(yield* channel, a.name))
          ? `Took down ${a.name}.`
          : `No artifact ${a.name}.`;
      }),
  }),
];
