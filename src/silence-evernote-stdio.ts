/**
 * Keep Evernote Thrift transport errors off MCP stdout.
 *
 * The evernote SDK's BinaryHttpTransport.log() defaults to console.log. On a
 * failed HTTP request it prints "Error making Thrift HTTP request: …" to
 * stdout, which corrupts the MCP JSON-RPC stream over stdio. Claude Desktop
 * then fails to parse responses (`Unexpected token 'E', "Error maki"...`) and
 * subsequent tool calls hang until the host's ~4-minute timeout.
 *
 * The SDK constructs transports without quiet=true, so we redirect log() to
 * stderr (safe for MCP) while preserving quiet mode.
 */

import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";

type BinaryHttpTransportCtor = {
  prototype: {
    log: (this: { quiet?: boolean }, msg: string) => void;
  };
};

const TRANSPORT_MODULE = "evernote/lib/thrift/transport/binaryHttpTransport.js";

function* packageJsonAnchors(): Generator<string> {
  yield join(process.cwd(), "package.json");

  let dir = dirname(process.argv[1] || process.cwd());
  for (let i = 0; i < 8; i++) {
    yield join(dir, "package.json");
    const parent = dirname(dir);
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}

function loadBinaryHttpTransport(): BinaryHttpTransportCtor {
  const errors: string[] = [];
  for (const anchor of packageJsonAnchors()) {
    if (!existsSync(anchor)) {
      continue;
    }
    try {
      return createRequire(anchor)(TRANSPORT_MODULE) as BinaryHttpTransportCtor;
    } catch (error) {
      errors.push(
        `${anchor}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `Unable to load ${TRANSPORT_MODULE} for stdio silence patch. Tried:\n${errors.join("\n")}`,
  );
}

export function silenceEvernoteStdio(): void {
  const BinaryHttpTransport = loadBinaryHttpTransport();

  BinaryHttpTransport.prototype.log = function (msg: string) {
    if (this.quiet) {
      return;
    }
    console.error(msg);
  };
}
