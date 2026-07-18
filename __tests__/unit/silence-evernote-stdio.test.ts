import { readFileSync } from "fs";
import { resolve } from "path";
import { silenceEvernoteStdio } from "../../src/silence-evernote-stdio.js";

// evernote ships CJS; Jest/ts-jest can require it directly.
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

    expect(silenceCall).toBeGreaterThanOrEqual(0);
    expect(dotenvConfig).toBeGreaterThan(silenceCall);
  });
});
