export const DATA_KEY = /^[\w.-]{1,64}$/;
export const MAX_VALUE_BYTES = 256_000;
export const MAX_KEYS = 200;

const PAGE_DATA_ROOT = "d";

export const dataPrefix = (token: string): string => `${PAGE_DATA_ROOT}/${token}/`;
export const dataKey = (token: string, key: string): string => `${dataPrefix(token)}${key}`;

export const doNameOf = (threadId: string): string => threadId.replace(/^telegram:/, "");
