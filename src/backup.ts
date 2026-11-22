import { fromFiles, Store, toFiles, type ArchiveError, type StoreError } from "@mizook/memory";
import { Context, Effect, Layer, Schema } from "effect";
import { Artifacts } from "./artifacts.ts";
import { Blobs } from "./blobs.ts";
import { Settings } from "./config.ts";
import type { BlobError, ScheduleError, StateError, ToolError } from "./errors.ts";
import { Intents } from "./intents.ts";
import { Policies } from "./policies.ts";
import { Schedules } from "./schedules.ts";
import { Spec } from "./schedule.ts";
import { Skills } from "./skills.ts";
import { Host } from "./host.ts";
import { State } from "./state.ts";
import { packTar, unpackTar } from "./tar.ts";

export type BackupError = ArchiveError | BlobError | StateError | StoreError | ToolError;

const KEEP_BACKUPS = 14;
const DAY = 24 * 3_600_000;
const LINK_LIFETIME = 3_600_000;

const SchedulesFile = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      spec: Spec,
      prompt: Schema.String,
      skill: Schema.optionalKey(Schema.String),
      active: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
const SettingsFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const DataFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const ArtifactsFile = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, contentType: Schema.String })),
);
const SkillsFile = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      body: Schema.String,
      pinned: Schema.Boolean,
    }),
  ),
);
const IntentsFile = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      description: Schema.String,
      triggers: Schema.Array(Schema.String),
      created: Schema.Finite,
      expires: Schema.Finite,
      cooldown: Schema.Finite,
      maxFires: Schema.Finite,
      fireCount: Schema.Finite,
      lastFired: Schema.NullOr(Schema.Finite),
      state: Schema.Literals(["armed", "done", "cancelled", "expired"]),
    }),
  ),
);
const PoliciesFile = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      match: Schema.String,
      decision: Schema.Literals(["allow", "ask", "deny"]),
    }),
  ),
);

const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

/**
 * A channel as files: the memory in the design's layout (`main/`, `tree/`, `view.json`), and
 * beside it `schedules.json`, `settings.json`, `artifacts.json` and `artifacts/<name>`. It is both
 * the export you take away and the nightly backup, and `restoreTar` reads it back.
 */
export class Backup extends Context.Service<
  Backup,
  {
    readonly tar: Effect.Effect<Uint8Array, BackupError>;
    /** Write the archive to a link that works for an hour. */
    readonly exportLink: Effect.Effect<string, BackupError>;
    /** Back up when a day has passed since the last one. True when it ran. */
    backupIfDue(now: number): Effect.Effect<boolean, BackupError>;
    readonly nextBackupAt: Effect.Effect<number | undefined, StateError>;
    /** Load an archive into this channel, which must have no messages yet. */
    restoreTar(bytes: Uint8Array): Effect.Effect<void, BackupError | ToolError | ScheduleError>;
  }
>()("mizook/Backup") {
  static readonly layer = Layer.effect(
    Backup,
    Effect.gen(function* () {
      const store = yield* Store;
      const state = yield* State;
      const schedules = yield* Schedules;
      const skills = yield* Skills;
      const intents = yield* Intents;
      const policies = yield* Policies;
      const artifacts = yield* Artifacts;
      const blobs = yield* Blobs;
      const { publicUrl } = yield* Settings;
      // Exports and backups are filed under the agent's Durable Object.
      const { self } = yield* Host;
      const channel = self.doName;

      const tar = Effect.gen(function* () {
        const files: Record<string, string | Uint8Array> = { ...toFiles(yield* store.snapshot) };
        files["schedules.json"] = yield* Schema.encodeEffect(SchedulesFile)(
          (yield* schedules.all).map(({ spec, prompt, skill, active }) => ({
            spec,
            prompt,
            ...(skill === undefined ? {} : { skill }),
            active,
          })),
        ).pipe(Effect.orDie);
        files["skills.json"] = yield* Schema.encodeEffect(SkillsFile)(
          (yield* skills.list).map(({ name, description, body, pinned }) => ({
            name,
            description,
            body,
            pinned,
          })),
        ).pipe(Effect.orDie);
        files["intents.json"] = yield* Schema.encodeEffect(IntentsFile)(
          (yield* intents.list).map((intent) => ({
            description: intent.description,
            triggers: intent.triggers,
            created: intent.created,
            expires: intent.expires,
            cooldown: intent.cooldown,
            maxFires: intent.maxFires,
            fireCount: intent.fireCount,
            lastFired: intent.lastFired ?? null,
            state: intent.state,
          })),
        ).pipe(Effect.orDie);
        files["policies.json"] = yield* Schema.encodeEffect(PoliciesFile)(
          (yield* policies.list).map(({ match, decision }) => ({ match, decision })),
        ).pipe(Effect.orDie);
        files["settings.json"] = yield* Schema.encodeEffect(SettingsFile)(
          yield* state.settings,
        ).pipe(Effect.orDie);
        const published = yield* artifacts.contents;
        files["artifacts.json"] = yield* Schema.encodeEffect(ArtifactsFile)(
          published.map(({ artifact }) => ({
            name: artifact.name,
            contentType: artifact.contentType,
          })),
        ).pipe(Effect.orDie);
        for (const { artifact, body, data } of published) {
          files[`artifacts/${artifact.name}`] = body;
          // What a page saved goes with it.
          if (Object.keys(data).length > 0) {
            files[`artifacts-data/${artifact.name}.json`] = yield* Schema.encodeEffect(DataFile)(
              data,
            ).pipe(Effect.orDie);
          }
        }
        return yield* packTar(files);
      });

      const exportLink = Effect.gen(function* () {
        const key = token();
        yield* blobs.put(`x/${key}`, yield* tar, {
          contentType: "application/x-tar",
          meta: {
            expires: String(Date.now() + LINK_LIFETIME),
            filename: `${self.slug}.tar`,
          },
        });
        return `${publicUrl}/x/${key}`;
      });

      const backupIfDue = (now: number) =>
        Effect.gen(function* () {
          const due = Number((yield* state.meta("next_backup")) ?? "NaN");
          if (!Number.isFinite(due)) {
            // First look: start the clock. An empty chat needs no backup.
            yield* state.setMeta("next_backup", String(now + DAY));
            return false;
          }
          if (now < due) return false;
          yield* blobs.put(`backup/${channel}/${new Date(now).toISOString()}.tar`, yield* tar, {
            contentType: "application/x-tar",
          });
          const all = yield* blobs.list(`backup/${channel}/`);
          for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
            yield* blobs.delete(old);
          }
          yield* state.setMeta("next_backup", String(now + DAY));
          return true;
        });

      return Backup.of({
        tar,
        exportLink,
        backupIfDue,
        nextBackupAt: Effect.map(state.meta("next_backup"), (v) =>
          v === undefined ? undefined : Number(v),
        ),
        restoreTar: (bytes) =>
          Effect.gen(function* () {
            const files = yield* unpackTar(bytes);
            const text = (name: string) =>
              files[name] === undefined ? undefined : new TextDecoder().decode(files[name]);
            const memory = Object.fromEntries(
              Object.entries(files)
                .filter(
                  ([name]) =>
                    name.startsWith("main/") || name.startsWith("tree/") || name === "view.json",
                )
                .map(([name, body]) => [name, new TextDecoder().decode(body)]),
            );
            yield* store.restore(yield* fromFiles(memory));
            const settings = text("settings.json");
            if (settings) {
              const own = yield* Schema.decodeEffect(SettingsFile)(settings).pipe(Effect.orDie);
              for (const [key, value] of Object.entries(own))
                yield* state.setMeta(`setting:${key}`, value);
            }
            const list = text("schedules.json");
            if (list) {
              const all = yield* Schema.decodeEffect(SchedulesFile)(list).pipe(Effect.orDie);
              // A reminder whose time has passed cannot be made again: skip it.
              for (const { spec, prompt, skill, active } of all) {
                const made = yield* schedules
                  .create(spec, prompt, new Date(), skill)
                  .pipe(Effect.orElseSucceed(() => undefined));
                if (made && active === false) yield* schedules.pause(made.id).pipe(Effect.ignore);
              }
            }
            const skillsText = text("skills.json");
            if (skillsText) {
              const all = yield* Schema.decodeEffect(SkillsFile)(skillsText).pipe(Effect.orDie);
              for (const { name, description, body, pinned } of all) {
                yield* skills.save(name, description, body).pipe(Effect.ignore);
                if (pinned) yield* skills.pin(name).pipe(Effect.ignore);
              }
            }
            const intentsText = text("intents.json");
            if (intentsText) {
              const all = yield* Schema.decodeEffect(IntentsFile)(intentsText).pipe(Effect.orDie);
              for (const intent of all) {
                yield* intents
                  .restore({ ...intent, lastFired: intent.lastFired ?? undefined })
                  .pipe(Effect.ignore);
              }
            }
            const policiesText = text("policies.json");
            if (policiesText) {
              const all = yield* Schema.decodeEffect(PoliciesFile)(policiesText).pipe(Effect.orDie);
              for (const { match, decision } of all) {
                yield* policies.add(match, decision).pipe(Effect.ignore);
              }
            }
            const meta = text("artifacts.json");
            if (meta) {
              const all = yield* Schema.decodeEffect(ArtifactsFile)(meta).pipe(Effect.orDie);
              for (const { name, contentType } of all) {
                const body = files[`artifacts/${name}`];
                if (body) {
                  yield* artifacts.publish(
                    channel,
                    name,
                    new TextDecoder().decode(body),
                    contentType,
                  );
                  const saved = text(`artifacts-data/${name}.json`);
                  if (saved) {
                    const data = yield* Schema.decodeEffect(DataFile)(saved).pipe(Effect.orDie);
                    for (const [key, json] of Object.entries(data)) {
                      yield* artifacts.data.set(name, key, json);
                    }
                  }
                }
              }
            }
          }),
      });
    }),
  );
}
