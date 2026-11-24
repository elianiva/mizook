import { Effect, Schema } from "effect";

export const described = <S extends Schema.Top>(schema: S, description: string): S["Rebuild"] =>
  schema.annotate({ description });

/**
 * One tool: what the model reads about it and what runs when it is called. `name` is what
 * `Handlers` dispatches on; `path` is how a program calls it (`tools.<path>`), and a tool without
 * one is not in the catalog. `run` takes raw input and decodes it with `args`.
 */
export interface ModelTool<R = never> {
  readonly name: string;
  readonly path?: string;
  readonly description: string;
  readonly args: Schema.Decoder<unknown>;
  readonly run: (
    args: unknown,
    place: string | undefined,
  ) => Effect.Effect<string, { readonly message: string }, R>;
}

export type ToolServices<T> = T extends ModelTool<infer R> ? R : never;

export const defineTool = <A, R>(tool: {
  readonly name: string;
  readonly path?: string;
  readonly description: string;
  readonly args: Schema.Decoder<A>;
  readonly run: (
    args: A,
    place: string | undefined,
  ) => Effect.Effect<string, { readonly message: string }, R>;
}): ModelTool<R> => ({
  ...tool,
  run: (args, place) =>
    Effect.flatMap(Schema.decodeUnknownEffect(tool.args)(args), (decoded) =>
      tool.run(decoded, place),
    ),
});
