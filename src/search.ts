import { Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Settings } from "./config.ts";
import { WebError } from "./errors.ts";
import { fetchPage, type Page } from "./web.ts";

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(
    query: string,
    limit: number,
    key: string,
  ): Effect.Effect<ReadonlyArray<SearchResult>, WebError, HttpClient.HttpClient>;
}

const post = <S extends Schema.Decoder<unknown>>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  schema: S,
) =>
  HttpClient.execute(
    HttpClientRequest.post(url, { headers }).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((cause) => new WebError({ url, reason: String(cause.message ?? cause) })),
  );

const ParallelResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optionalKey(Schema.NullOr(Schema.String)),
      excerpts: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    }),
  ),
});

const parallel: SearchProvider = {
  name: "parallel",
  search: (query, limit, key) =>
    post(
      "https://api.parallel.ai/v1/search",
      { "x-api-key": key },
      { objective: query, search_queries: [query], mode: "basic" },
      ParallelResponse,
    ).pipe(
      Effect.map((r) =>
        r.results.slice(0, limit).map((x) => ({
          title: x.title ?? x.url,
          url: x.url,
          snippet: (x.excerpts ?? []).join("\n").slice(0, 1_200),
        })),
      ),
    ),
};

const ExaResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optionalKey(Schema.NullOr(Schema.String)),
      text: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const exa: SearchProvider = {
  name: "exa",
  search: (query, limit, key) =>
    post(
      "https://api.exa.ai/search",
      { "x-api-key": key },
      { query, numResults: limit, contents: { text: { maxCharacters: 1_200 } } },
      ExaResponse,
    ).pipe(
      Effect.map((r) =>
        r.results.map((x) => ({ title: x.title ?? x.url, url: x.url, snippet: x.text ?? "" })),
      ),
    ),
};

export const providers: Record<string, SearchProvider> = { parallel, exa };

export const searchWith = (
  providersByPreference: ReadonlyArray<{ readonly provider: SearchProvider; readonly key: string }>,
  query: string,
  limit: number,
): Effect.Effect<ReadonlyArray<SearchResult>, WebError, HttpClient.HttpClient> =>
  providersByPreference.reduceRight<
    Effect.Effect<ReadonlyArray<SearchResult>, WebError, HttpClient.HttpClient>
  >(
    (tryRemainingProviders, { provider, key }) =>
      provider
        .search(query, limit, key)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`search provider ${provider.name} failed: ${error.message}`).pipe(
              Effect.andThen(tryRemainingProviders),
            ),
          ),
        ),
    Effect.fail(new WebError({ url: "search", reason: "no search provider answered" })),
  );

const DEFAULT_SEARCH_RESULT_COUNT = 6;

export class Web extends Context.Service<
  Web,
  {
    search(query: string, limit?: number): Effect.Effect<string, WebError>;
    fetch(url: string): Effect.Effect<Page, WebError>;
  }
>()("mizook/Web") {
  static readonly layer = Layer.effect(
    Web,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const settings = yield* Settings;
      const configuredProvidersWithKeys = settings.searchProviders.flatMap((name) => {
        const provider = providers[name];
        const key = settings.searchKeys[name] ? Redacted.value(settings.searchKeys[name]) : "";
        return provider && key !== "" ? [{ provider, key }] : [];
      });
      return Web.of({
        search: (query, limit = DEFAULT_SEARCH_RESULT_COUNT) =>
          searchWith(configuredProvidersWithKeys, query, limit).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.map((results) =>
              results.length === 0
                ? "No results."
                : results
                    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
                    .join("\n\n"),
            ),
          ),
        fetch: (url) => fetchPage(url).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      });
    }),
  );
}
