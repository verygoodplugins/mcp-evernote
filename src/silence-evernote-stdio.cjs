'use strict';

/**
 * Keep Evernote Thrift transport errors off MCP stdout.
 *
 * The evernote SDK's BinaryHttpTransport.log() defaults to console.log. On a
 * failed HTTP request it prints "Error making Thrift HTTP request: …" to
 * stdout, which corrupts the MCP JSON-RPC stream over stdio. Claude Desktop
 * then fails to parse responses (`Unexpected token 'E', "Error maki"...`) and
 * subsequent tool calls hang until the host's ~4-minute timeout.
 *
 * Implemented as CJS so require() resolves the sibling transport shim relative
 * to this package (including global npm bin installs) without import.meta.
 */

const BinaryHttpTransport = require('./evernote-binary-http-transport.cjs');

function silenceEvernoteStdio() {
  BinaryHttpTransport.prototype.log = function (msg) {
    if (this.quiet) {
      return;
    }
    console.error(msg);
  };
}

module.exports = { silenceEvernoteStdio };
