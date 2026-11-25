import { MAX_ATTACHMENT_BYTES } from "@mizook/chat-sync";
import { accessWho } from "./admin/access.ts";
import type { Env } from "./env.ts";

/** Images the chat can show; SVG is left out because it can carry scripts. */
const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
} as const;

type ImageType = keyof typeof IMAGE_EXTENSIONS;

const MEDIA_FILE = /^[\w-]+\.(?:png|jpe?g|webp|gif|avif)$/;
const NAME_HEADER = "x-mizook-name";
const MAX_NAME_CHARS = 120;
const MEDIA_KEY_PREFIX = "inbox/web/";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const isImageType = (type: string): type is ImageType => Object.hasOwn(IMAGE_EXTENSIONS, type);

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const displayName = (encoded: string | null, extension: string): string => {
  const decoded = encoded === null ? "" : safeDecode(encoded);
  let cleaned = "";
  for (const character of decoded) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += character;
  }
  const trimmed = cleaned.trim();
  return trimmed === "" ? `image.${extension}` : trimmed.slice(0, MAX_NAME_CHARS);
};

/** Stores one image in the inbox and answers with what the chat message records. */
export const uploadWebMedia = async (request: Request, env: Env): Promise<Response> => {
  const actor = await accessWho(request, env, env.CHAT_ACCESS_AUD);
  if (actor === undefined) {
    return json({ reason: "Your session expired. Reload the page." }, 401);
  }

  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isImageType(type)) {
    return json({ reason: "Only PNG, JPEG, WebP, GIF or AVIF images work." }, 415);
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_ATTACHMENT_BYTES) {
    return json({ reason: "That image is too large." }, 413);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return json({ reason: "That image is empty." }, 400);
  if (bytes.length > MAX_ATTACHMENT_BYTES) return json({ reason: "That image is too large." }, 413);

  const extension = IMAGE_EXTENSIONS[type];
  const key = `${MEDIA_KEY_PREFIX}${crypto.randomUUID()}.${extension}`;
  try {
    await env.Files.put(key, bytes, { httpMetadata: { contentType: type } });
  } catch {
    return json({ reason: "Could not store that image." }, 500);
  }

  return json({
    key,
    name: displayName(request.headers.get(NAME_HEADER), extension),
    type,
    size: bytes.length,
  });
};

/** Serves an uploaded image back to the chat, behind the same Access app as `/c`. */
export const serveWebMedia = async (
  request: Request,
  env: Env,
  file: string,
): Promise<Response> => {
  if (!MEDIA_FILE.test(file)) return new Response("Not found", { status: 404 });
  const actor = await accessWho(request, env, env.CHAT_ACCESS_AUD);
  if (actor === undefined) return new Response("Unauthorized", { status: 401 });

  const object = await env.Files.get(`${MEDIA_KEY_PREFIX}${file}`);
  if (object === null) return new Response("Not found", { status: 404 });

  const type = object.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "content-type": type,
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    },
  });
};
