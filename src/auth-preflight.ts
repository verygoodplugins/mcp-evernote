/**
 * Startup credential preflight.
 *
 * The server authenticates with an access token alone: `EvernoteOAuth` builds
 * its client as `new Evernote.Client({ token, sandbox, china })` and never
 * reads the consumer key/secret. Those belong to the standalone OAuth flow in
 * `auth-standalone.ts`, which reads them from the environment itself.
 *
 * So a missing consumer key is not a fatal condition — it is only worth
 * mentioning when there is also no token to use and no way to obtain one.
 */
import { existsSync } from "fs";
import path from "path";

/** Token file `EvernoteOAuth` falls back to, relative to the working directory. */
export const TOKEN_FILE_NAME = ".evernote-token.json";

/**
 * Whether any token source is configured.
 *
 * The file fallback is probed with a sync existence check because this runs at
 * module load; `EvernoteOAuth` re-reads and validates it at auth time, so a
 * corrupt or expired file still fails later with a precise message.
 */
export function hasConfiguredTokenSource(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  fileExists: (filePath: string) => boolean = existsSync,
): boolean {
  if (env.EVERNOTE_ACCESS_TOKEN) {
    return true;
  }
  // Mirrors oauth.ts: the Claude Code token is only honored when that
  // environment is detected.
  if ((env.MCP_TRANSPORT || env.CLAUDE_CODE_MCP) && env.OAUTH_TOKEN) {
    return true;
  }
  return fileExists(path.join(cwd, TOKEN_FILE_NAME));
}

/**
 * Whether to print the "not configured" notice: no token to use, and no
 * consumer credentials to obtain one with. Anything else starts quietly.
 */
export function needsSetupNotice(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  fileExists: (filePath: string) => boolean = existsSync,
): boolean {
  if (hasConfiguredTokenSource(env, cwd, fileExists)) {
    return false;
  }
  return !env.EVERNOTE_CONSUMER_KEY || !env.EVERNOTE_CONSUMER_SECRET;
}
