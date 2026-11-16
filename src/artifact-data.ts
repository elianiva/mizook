/** The little key-value store behind a published page, in R2 under `d/<token>/<key>`. The page's link is its key. */
export const DATA_KEY = /^[\w.-]{1,64}$/;
export const MAX_VALUE_BYTES = 256_000;
export const MAX_KEYS = 200;

export const dataPrefix = (token: string): string => `d/${token}/`;
export const dataKey = (token: string, key: string): string => `${dataPrefix(token)}${key}`;

/** The name of the channel's Durable Object, from the thread id its files are filed under. */
export const doNameOf = (channel: string): string => channel.replace(/^telegram:/, "");
