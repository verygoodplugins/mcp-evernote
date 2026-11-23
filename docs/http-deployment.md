# Deploying HTTP Mode as a Supervised Service

[HTTP mode](../README.md#http-server-mode-one-shared-instance) runs one
long-lived server that every local client connects to. Nothing starts that
process for you, so this page covers the part the HTTP-mode section doesn't:
what keeps it running, where its logs go, and how to hand it caller keys
without writing them into a world-readable service file.

Examples use `/path/to/mcp-evernote` for the checkout, `USERNAME` for an
account name and `<caller>` for a client name. Substitute your own absolute
paths — none of the supervisors below expand `~`.

## Why run one supervised process

Evernote's rate limit is **per auth token per hour, not per process**. Running
a stdio server per client doesn't buy you more quota; it splits the things that
make the quota last:

- **One request queue.** `src/request-queue.ts` builds a single
  `EvernoteRequestQueue` shared by every session, so concurrency, pacing and
  rate-limit backoff are global. When Evernote returns errorCode 19 the whole
  queue pauses once. Three stdio processes each back off independently and
  retry into the same exhausted quota.
- **One note cache.** The USN-keyed body cache lives on a single module-level
  `EvernoteAPI` instance (`src/index.ts`), so a note read by one client is
  served from memory for the next. Per-client processes each start cold and
  re-spend a `getNote` call on the same note.

The tradeoff is that process supervision moves from the MCP client to you. A
stdio server lives and dies with the client that spawned it; an HTTP server
that nobody restarts is just an `ECONNREFUSED` waiting to happen.

## Before you write a service file

1. **Build first.** The bins run from `dist/`, so an unbuilt checkout fails at
   startup in a loop that looks exactly like a crash:

   ```bash
   cd /path/to/mcp-evernote && npm ci && npm run build
   ```

2. **Use an absolute path to `node`.** launchd runs jobs with a minimal
   `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), and systemd units get no login
   shell. A Homebrew, `nvm` or `fnm` node is on none of those paths, so a bare
   `node` exits 127 forever. Record yours with `command -v node`.

3. **Know which variables are mandatory.** `EVERNOTE_CONSUMER_KEY` and
   `EVERNOTE_CONSUMER_SECRET` are validated at startup and the process exits 1
   without them — including when you authenticate with a cookie token. You
   also need a token (`EVERNOTE_ACCESS_TOKEN`) and, unless you set
   `EVERNOTE_HTTP_ALLOW_UNAUTHENTICATED=true` on a loopback host,
   `EVERNOTE_HTTP_CALLER_KEYS`.

4. **Set the working directory explicitly.** launchd defaults it to `/`. Two
   things depend on it: the `.evernote-token.json` fallback is read from the
   working directory, and the default attachment allow-list is
   `[os.homedir(), process.cwd()]` — so a job running from `/` silently
   widens that allow-list to the whole filesystem. Set `WorkingDirectory`, and
   set `EVERNOTE_ALLOWED_FILE_ROOTS` rather than inheriting the default.

## Supplying caller keys without leaking them

A LaunchAgent plist is mode 0644 and a systemd unit is world-readable. Neither
is a place for a bearer key or an Evernote token. Keep the secrets in an OS
secret store and have a small wrapper assemble them at start.

Generate one key per caller:

```bash
openssl rand -hex 32
```

Store each one so the value never enters shell history — passing `-w` **last**
makes `security` prompt for it interactively:

```bash
security add-generic-password -a <caller> -s mcp-evernote-http -w
```

On Linux, `secret-tool` prompts the same way:

```bash
secret-tool store --label="mcp-evernote <caller>" service mcp-evernote-http account <caller>
```

### Wrapper script

Save as `/path/to/mcp-evernote/bin/mcp-evernote-http-launcher` and
`chmod +x` it. It fails closed: a missing secret aborts with a message naming
the caller, never the value.

```bash
#!/bin/bash
# Assembles secrets from an OS secret store and execs the server.
# Works on macOS (security) and Linux (secret-tool), and defers to any value
# already in the environment so an EnvironmentFile can supply it instead.
# Keep /bin/bash 3.2 compatible (macOS) — no associative arrays.
set -euo pipefail

APP_DIR="/path/to/mcp-evernote"
NODE_BIN="/absolute/path/to/node"   # command -v node
SERVICE="mcp-evernote-http"
CALLERS="hub cursor desktop"        # one name per client

# Read one secret. An already-set value wins, so EnvironmentFile and the
# secret stores are interchangeable. Prints the secret, or fails naming the
# account — never the value.
fetch() {
  local account="$1" preset="${2-}" value=""
  if [ -n "$preset" ]; then
    printf '%s' "$preset"
    return 0
  fi
  if command -v security >/dev/null 2>&1; then
    value="$(security find-generic-password -a "$account" -s "$SERVICE" -w 2>/dev/null)" || value=""
  elif command -v secret-tool >/dev/null 2>&1; then
    value="$(secret-tool lookup service "$SERVICE" account "$account" 2>/dev/null)" || value=""
  fi
  if [ -z "$value" ]; then
    echo "mcp-evernote: no secret for account '$account' (service=$SERVICE)." >&2
    echo "  Store it with security/secret-tool, or supply it via EnvironmentFile." >&2
    return 1
  fi
  printf '%s' "$value"
}

# Assign, check, then export: `export X="$(fetch ...)"` would mask the failure.
EVERNOTE_CONSUMER_KEY="$(fetch consumer-key "${EVERNOTE_CONSUMER_KEY-}")" || exit 78
EVERNOTE_CONSUMER_SECRET="$(fetch consumer-secret "${EVERNOTE_CONSUMER_SECRET-}")" || exit 78
EVERNOTE_ACCESS_TOKEN="$(fetch access-token "${EVERNOTE_ACCESS_TOKEN-}")" || exit 78
export EVERNOTE_CONSUMER_KEY EVERNOTE_CONSUMER_SECRET EVERNOTE_ACCESS_TOKEN

# Already supplied whole (EnvironmentFile)? Keep it. Otherwise assemble it.
if [ -z "${EVERNOTE_HTTP_CALLER_KEYS-}" ]; then
  keys=""
  for caller in $CALLERS; do
    key="$(fetch "$caller")" || exit 78
    [ -n "$keys" ] && keys="$keys,"
    keys="$keys$caller:$key"
  done
  EVERNOTE_HTTP_CALLER_KEYS="$keys"
fi
export EVERNOTE_HTTP_CALLER_KEYS

export EVERNOTE_ALLOWED_FILE_ROOTS="${EVERNOTE_ALLOWED_FILE_ROOTS:-$HOME/Documents}"
cd "$APP_DIR"

# exec so signals reach node and the supervisor tracks the right PID.
exec "$NODE_BIN" "$APP_DIR/dist/index.js" --http
```

Three details worth keeping. `exec` means `SIGTERM` reaches node instead of
the shell. There is no `set -x` — the wrapper's stderr is your log file, and
tracing would print every secret into it. And because an already-set value
wins over a store lookup, the same script works unchanged whether secrets come
from the Keychain, from `secret-tool`, or from an `EnvironmentFile`.

That last point matters on a headless Linux box, where `secret-tool` needs an
unlocked keyring and a session bus that a boot-time service has neither of.
There, drop the `EnvironmentFile` line in the unit below and let it populate
the variables; the wrapper will pass them through rather than overwrite them.
An `EnvironmentFile` holding caller keys should set
`EVERNOTE_HTTP_CALLER_KEYS` whole:

```bash
# ~/.config/mcp-evernote/http.env — chmod 0600, owned by the service user
EVERNOTE_CONSUMER_KEY=...
EVERNOTE_CONSUMER_SECRET=...
EVERNOTE_ACCESS_TOKEN=...
EVERNOTE_HTTP_CALLER_KEYS=hub:...,cursor:...
```

## macOS: launchd

Save as `~/Library/LaunchAgents/com.example.mcp-evernote.plist`. It must be a
**LaunchAgent**, not a LaunchDaemon — only an agent in your GUI session can
read the login Keychain.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.mcp-evernote</string>

    <key>ProgramArguments</key>
    <array>
        <string>/path/to/mcp-evernote/bin/mcp-evernote-http-launcher</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/path/to/mcp-evernote</string>

    <key>RunAtLoad</key>
    <true/>

    <!-- Unconditional: the server exits 0 on SIGTERM, so a SuccessfulExit
         policy would leave it down after anything kills it politely. -->
    <key>KeepAlive</key>
    <true/>

    <!-- Floor between restarts. Without it a misconfiguration (missing key,
         port in use) respawns as fast as the process can exit. -->
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <!-- Everything the server logs goes to stderr, so StandardErrorPath is
         the one that matters. Absolute paths only; launchd won't expand ~. -->
    <key>StandardOutPath</key>
    <string>/Users/USERNAME/Library/Logs/mcp-evernote/http.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/USERNAME/Library/Logs/mcp-evernote/http.err.log</string>
</dict>
</plist>
```

**Don't point the logs at `/tmp`.** Periodic cleanup deletes files there, so
the one record of why the server died disappears before you go looking for it.
`~/Library/Logs/` survives reboots and is what Console.app reads.

Create the log directory first — launchd will not, and a missing directory
makes the job fail to spawn:

```bash
mkdir -p ~/Library/Logs/mcp-evernote
```

Load, check and unload:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.mcp-evernote.plist
launchctl print gui/$(id -u)/com.example.mcp-evernote
launchctl bootout gui/$(id -u)/com.example.mcp-evernote
```

## Linux: systemd

A `--user` unit keeps the service under your own account, where a secret
store is reachable. Save as
`~/.config/systemd/user/mcp-evernote.service`:

```ini
[Unit]
Description=MCP Evernote (Streamable HTTP)
# No network ordering: the default bind is loopback, which is always up.
# (`network-online.target` is a system target a --user unit can't order
# against anyway.)

[Service]
Type=simple
WorkingDirectory=/path/to/mcp-evernote
ExecStart=/path/to/mcp-evernote/bin/mcp-evernote-http-launcher

# Not on-failure: the server exits 0 on SIGTERM, so on-failure would leave it
# down after an external kill. `systemctl --user stop` still keeps it stopped.
Restart=always
RestartSec=10

# Optional alternative to a secret-store wrapper. Must be owned by this user
# and chmod 0600 — a --user unit cannot read a root-owned file.
# EnvironmentFile=%h/.config/mcp-evernote/http.env

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now mcp-evernote
journalctl --user -u mcp-evernote -f
```

Two things that bite:

- **Enable lingering** or the service stops when you log out and never starts
  at boot: `loginctl enable-linger $USER`.
- **A volatile journal is the Linux `/tmp` problem.** If
  `/var/log/journal` doesn't exist, logs are memory-only and vanish on reboot,
  taking the crash with them. `sudo mkdir -p /var/log/journal &&
  sudo systemd-tmpfiles --create` makes them persistent.

## Readiness and liveness

`GET /healthz` is unauthenticated and returns `{"status":"ok"}`. Use it as a
startup probe and as the first check after a restart:

```bash
curl -fsS http://127.0.0.1:3100/healthz
```

It proves the listener is up and **nothing more**. Evernote auth is lazy — the
first tool call initializes the client — so `/healthz` returns `ok` with an
expired token. For a real check, use the authenticated endpoint:

```bash
curl -fsS -H "Authorization: Bearer <key>" http://127.0.0.1:3100/metrics
```

`/metrics` returns session counts and the shared queue's metrics, including
`backoff.active` when the queue is paused on a rate limit. From a connected
client, `evernote_connection({action:"status"})` exercises the credentials
end to end.

Probe on `127.0.0.1` or a name in `EVERNOTE_HTTP_ALLOWED_HOSTS`. Host-header
validation is mounted ahead of the routes, so a probe using an unlisted
hostname is rejected before `/healthz` ever runs.

**Watch the restart counter.** `runs` in `launchctl print
gui/$(id -u)/<label>`, or `systemctl --user show -p NRestarts mcp-evernote`.
A counter climbing while you aren't touching anything means the process isn't
staying up, and the log says which kind:

- An error at every start is a crash loop — bad config, unbuilt `dist/`, port
  already taken.
- `Evernote MCP server listening on …` followed by silence means something
  external is killing a healthy process. See the last troubleshooting entry.

## Troubleshooting

#### `ECONNREFUSED` from every client

Nothing is listening. This is a supervisor problem, not a config problem —
checking the client's URL and key will waste your time. Confirm the service
is loaded and look at its log:

```bash
launchctl print gui/$(id -u)/com.example.mcp-evernote   # macOS
systemctl --user status mcp-evernote                     # Linux
```

#### `401 Unauthorized: missing or invalid caller key`

The client's bearer key doesn't match any configured key. Keys are compared
whole, so a trailing newline from a secret store is a mismatch. Note that
`EVERNOTE_HTTP_CALLER_KEYS` splits each entry on the **first** colon, and an
entry whose key is empty is dropped silently — a failed secret lookup that
produced `<caller>:` yields 401s with nothing in the server log. The wrapper
above exits instead, which is the point of it.

#### `404 Session not found` after a restart

Sessions are held in memory and don't survive a restart. Clients must
reinitialize; most do automatically on the next call. Sessions are also bound
to the caller that opened them, so a session ID can't be reused across keys.

#### `EADDRINUSE` on startup

Another instance already holds the port — commonly a manually started server
from testing, or a second supervisor definition. Stop it, or move this one
with `EVERNOTE_HTTP_PORT`.

#### The server disappears every few hours

Process reapers and cleanup daemons that target stray MCP helpers match on
"parented by the init/supervisor process, no controlling terminal, not a child
of any MCP client" — which is precisely what a correctly supervised server
looks like. If your environment runs one, add an explicit exemption for this
process. The symptom is the second log pattern above: a clean startup line,
then silence, then a restart, with no error in between.
