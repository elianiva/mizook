export interface Env extends Cloudflare.Env {
  BOT_TOKEN: string;
  OPENCODE_GO_API_KEY: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  EXA_API_KEY?: string;
  CF_API_TOKEN?: string;
  BASE_URL?: string;
}
