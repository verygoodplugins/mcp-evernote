import { readFileSync } from "fs";
import { resolve } from "path";

// CJS silence module + Evernote transport (package-local require, not cwd/argv).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { silenceEvernoteStdio } = require("../../src/silence-evernote-stdio.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BinaryHttpTransport = require("evernote/lib/thrift/transport/binaryHttpTransport.js");

describe("silenceEvernoteStdio", () => {
  const originalLog = BinaryHttpTransport.prototype.log;

  afterEach(() => {
    BinaryHttpTransport.prototype.log = originalLog;
    jest.restoreAllMocks();
  });

  it("redirects BinaryHttpTransport.log from stdout to stderr", () => {
    const stdout = jest.spyOn(console, "log").mockImplementation(() => {});
    const stderr = jest.spyOn(console, "error").mockImplementation(() => {});
    stderr.mockClear();
    stdout.mockClear();

    silenceEvernoteStdio();

    const transport = new BinaryHttpTransport("https://example.com/notestore");
    transport.log("Error making Thrift HTTP request: socket hang up");

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      "Error making Thrift HTTP request: socket hang up",
    );
  });

  it("still respects quiet=true (no logging)", () => {
    const stdout = jest.spyOn(console, "log").mockImplementation(() => {});
    const stderr = jest.spyOn(console, "error").mockImplementation(() => {});
    stderr.mockClear();
    stdout.mockClear();

    silenceEvernoteStdio();

    const transport = new BinaryHttpTransport(
      "https://example.com/notestore",
      true,
    );
    expect(transport.quiet).toBe(true);

    transport.log("Error making Thrift HTTP request: socket hang up");

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("is applied by the MCP stdio entrypoint before dotenv/config work", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/index.ts"),
      "utf-8",
    );
    const silenceCall = source.indexOf("silenceEvernoteStdio()");
    const dotenvConfig = source.indexOf("config({ quiet: true })");

    expect(source).toContain('"./silence-evernote-stdio.cjs"');
    expect(silenceCall).toBeGreaterThanOrEqual(0);
    expect(dotenvConfig).toBeGreaterThan(silenceCall);
  });

  it("loads the transport via a package-local CJS shim", () => {
    const shim = readFileSync(
      resolve(__dirname, "../../src/silence-evernote-stdio.cjs"),
      "utf-8",
    );
    // Strip comments before asserting we never resolve via cwd/argv.
    const code = shim.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("./evernote-binary-http-transport.cjs");
    expect(code).not.toMatch(/process\.cwd|process\.argv/);
  });
});
