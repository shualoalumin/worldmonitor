#!/usr/bin/env node
// MCP client setup helper — emits (or merges) the World Monitor MCP server entry
// for a given client, and verifies that the endpoint actually answers.
//
// WHY THIS EXISTS: docs/mcp-quickstart.mdx shows the config snippets, but the
// two things that actually go wrong are mechanical:
//   1. Hand-merging JSON into an existing config clobbers the other servers, or
//      lands the entry one nesting level off, and the client silently starts
//      with no tools.
//   2. Discovery is anonymous by design — initialize and tools/list answer 200
//      without credentials — so a misconfigured key looks perfectly healthy
//      until the first tools/call returns 401. "It connected" is not evidence
//      that it works.
// So: --write merges instead of overwriting (existing servers preserved, backup
// written), and --verify walks past discovery into a real authenticated call.
//
// Usage:
//   node scripts/mcp-client-setup.mjs --print-config <client>
//   node scripts/mcp-client-setup.mjs --write <path> [--client <client>]
//   node scripts/mcp-client-setup.mjs --verify [--api-key <key>]
//
//   <client> is one of: claude-desktop, claude-code, cursor, mcp-remote
//     claude-desktop / cursor / claude-code — native remote entry (`url`),
//       OAuth on first use, no key stored on disk.
//     mcp-remote — stdio bridge for older clients, authenticates with the
//       X-WorldMonitor-Key header (the deterministic path when a client's
//       mid-session OAuth flow is unreliable).
//
//   --api-key <key>   key for --verify's authenticated call and for the
//                     mcp-remote config (default: $WORLDMONITOR_API_KEY)
//   --mcp-url <url>   endpoint (default: $WORLDMONITOR_MCP_URL or
//                     https://worldmonitor.app/mcp)
//   --timeout <ms>    per-request timeout (default: 15000)
//   -h, --help
//
// Exit codes: 0 success · 1 verification or write failure · 2 usage error

const DEFAULT_MCP_URL = 'https://worldmonitor.app/mcp';
const DEFAULT_TIMEOUT_MS = 15_000;
const API_KEY_HEADER = 'X-WorldMonitor-Key';
const USER_AGENT = 'WorldMonitor-MCP-Setup/1.0 (+https://worldmonitor.app)';
const SERVER_KEY = 'worldmonitor';
// Cheapest authenticated tool: a cache read, no upstream fan-out. `limit: 1`
// keeps the response small — the point is the auth wall, not the payload.
const VERIFY_TOOL = { name: 'get_market_data', arguments: { limit: 1, jmespath: 'keys(@) | [0]' } };

class UsageError extends Error {}

// client id → { file, note, entry(config) }. `file` is where the client keeps
// its config on macOS; the helper never guesses the path for --write, it is
// printed so the user can point --write at it.
const CLIENTS = {
  'claude-desktop': {
    file: '~/Library/Application Support/Claude/claude_desktop_config.json (macOS) · %APPDATA%\\Claude\\claude_desktop_config.json (Windows)',
    root: 'mcpServers',
    note: 'Restart Claude Desktop, then mention WorldMonitor in a chat to trigger the OAuth consent screen.',
    entry: (config) => ({ url: config.mcpUrl }),
  },
  'claude-code': {
    file: '.mcp.json in the project root (or ~/.claude.json for a user-scoped server)',
    root: 'mcpServers',
    note: 'Run `claude mcp list` to confirm the server is registered.',
    entry: (config) => ({ type: 'http', url: config.mcpUrl }),
  },
  cursor: {
    file: '~/.cursor/mcp.json (or .cursor/mcp.json in the project)',
    root: 'mcpServers',
    note: 'Reload the Cursor window after editing.',
    entry: (config) => ({ url: config.mcpUrl }),
  },
  'mcp-remote': {
    file: 'the same config file as your client — this is the stdio-bridge form of the entry',
    root: 'mcpServers',
    note: 'Pass the header as ONE argument with no space after the colon; a space breaks argument escaping on Windows and in Cursor.',
    entry: (config) => ({
      command: 'npx',
      args: [
        '-y', 'mcp-remote', config.mcpUrl,
        '--header', `${API_KEY_HEADER}:${config.apiKey || 'wm_YOUR_KEY'}`,
      ],
    }),
  },
};

// ─── config rendering ────────────────────────────────────────────────────────

export function buildEntry(client, config) {
  const spec = CLIENTS[client];
  if (!spec) throw new UsageError(`unknown client: ${client} — known: ${Object.keys(CLIENTS).join(', ')}`);
  return spec.entry(config);
}

export function renderConfig(client, config) {
  const spec = CLIENTS[client];
  if (!spec) throw new UsageError(`unknown client: ${client} — known: ${Object.keys(CLIENTS).join(', ')}`);
  return JSON.stringify({ [spec.root]: { [SERVER_KEY]: spec.entry(config) } }, null, 2);
}

// Merge the worldmonitor entry into an existing config object without touching
// anything else. Returns { merged, replaced } so the caller can tell the user
// whether it added a server or updated one.
export function mergeConfig(existing, client, config) {
  const spec = CLIENTS[client];
  if (!spec) throw new UsageError(`unknown client: ${client} — known: ${Object.keys(CLIENTS).join(', ')}`);
  if (existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) {
    throw new UsageError('existing config is not a JSON object — refusing to overwrite it');
  }
  const base = existing ?? {};
  const servers = base[spec.root];
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    throw new UsageError(`existing "${spec.root}" is not a JSON object — refusing to overwrite it`);
  }
  const replaced = Boolean(servers && SERVER_KEY in servers);
  return {
    replaced,
    merged: { ...base, [spec.root]: { ...(servers ?? {}), [SERVER_KEY]: spec.entry(config) } },
  };
}

// ─── verification ────────────────────────────────────────────────────────────

// The timeout covers body read, not just headers — an endpoint that sends
// headers then stalls must report as a failure, not idle until the shell is
// interrupted.
async function rpc(config, method, params, { apiKey } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);
  try {
    const response = await fetch(config.mcpUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': USER_AGENT,
        ...(apiKey ? { [API_KEY_HEADER]: apiKey } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: parseBody(text, response.headers) };
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(text, headers) {
  const contentType = headers?.get?.('content-type') ?? '';
  let payload = text;
  if (contentType.includes('text/event-stream') || /^(event|data):/m.test(text)) {
    const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    payload = dataLines[dataLines.length - 1] || '';
  }
  if (!payload) return text;
  try {
    return JSON.parse(payload);
  } catch {
    return text;
  }
}

// Three steps, in the order the failures actually happen:
//   1. initialize — is the endpoint reachable and speaking MCP at all
//   2. tools/list — anonymous discovery (works without a key by design)
//   3. tools/call — the first step that needs credentials, i.e. the only one
//      that proves the key and its tier
// Step 3 is skipped, not failed, when no key is available: printing the config
// is still useful for an OAuth client that never holds a key on disk.
export async function verify(config, io = {}) {
  const call = io.rpc ?? rpc;
  const steps = [];

  const record = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };

  try {
    const init = await call(config, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'worldmonitor-mcp-setup', version: '1.0' },
    });
    if (init.status !== 200) {
      record('initialize', false, `HTTP ${init.status}`);
      return steps;
    }
    const serverName = init.body?.result?.serverInfo?.name ?? 'unknown server';
    record('initialize', true, serverName);
  } catch (error) {
    record('initialize', false, error.name === 'AbortError' ? `no response within ${config.timeout}ms` : error.message);
    return steps;
  }

  try {
    const list = await call(config, 'tools/list', {});
    const tools = list.body?.result?.tools;
    if (list.status !== 200 || !Array.isArray(tools)) {
      record('tools/list', false, `HTTP ${list.status}`);
    } else {
      record('tools/list', true, `${tools.length} tool(s) advertised`);
    }
  } catch (error) {
    record('tools/list', false, error.message);
  }

  if (!config.apiKey) {
    record('tools/call', true, 'skipped — no API key provided (OAuth clients authenticate in the browser instead)');
    return steps;
  }

  try {
    const called = await call(config, 'tools/call', VERIFY_TOOL, { apiKey: config.apiKey });
    if (called.status === 401) {
      record('tools/call', false, 'HTTP 401 — key rejected. Check the key value and that its plan reaches MCP (free tier cannot).');
    } else if (called.status !== 200) {
      record('tools/call', false, `HTTP ${called.status}`);
    } else if (called.body?.error) {
      record('tools/call', false, called.body.error.message ?? JSON.stringify(called.body.error));
    } else {
      record('tools/call', true, `${VERIFY_TOOL.name} answered`);
    }
  } catch (error) {
    record('tools/call', false, error.message);
  }

  return steps;
}

// ─── argument parsing ────────────────────────────────────────────────────────

const VALUE_FLAGS = new Map([
  ['print-config', 'printConfig'],
  ['client', 'client'],
  ['write', 'write'],
  ['api-key', 'apiKey'], ['apikey', 'apiKey'], ['key', 'apiKey'],
  ['mcp-url', 'mcpUrl'],
  ['timeout', 'timeout'],
]);

const BOOL_FLAGS = new Map([['verify', 'verify'], ['help', 'help'], ['h', 'help']]);

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) throw new UsageError(`unexpected argument: ${token}`);
    const name = token.replace(/^--?/, '');
    if (BOOL_FLAGS.has(name)) { options[BOOL_FLAGS.get(name)] = true; continue; }
    const key = VALUE_FLAGS.get(name);
    if (!key) throw new UsageError(`unknown flag: ${token}`);
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`--${name} requires a value`);
    options[key] = value;
  }
  return options;
}

export function resolveConfig(options, env = {}) {
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`--timeout must be a positive number (got ${options.timeout})`);
  return {
    mcpUrl: options.mcpUrl ?? env.WORLDMONITOR_MCP_URL ?? DEFAULT_MCP_URL,
    apiKey: options.apiKey ?? env.WORLDMONITOR_API_KEY ?? '',
    timeout,
  };
}

const HELP = `mcp-client-setup — configure and verify the World Monitor MCP server

  node scripts/mcp-client-setup.mjs --print-config <client>
  node scripts/mcp-client-setup.mjs --write <path> [--client <client>]
  node scripts/mcp-client-setup.mjs --verify [--api-key <key>]

  <client>          ${Object.keys(CLIENTS).join(', ')} (default: claude-desktop)
  --print-config    print the config snippet for <client>
  --write <path>    merge the entry into an existing JSON config (a .bak copy is
                    written first; other servers are preserved)
  --verify          initialize + tools/list, then one authenticated tools/call
                    when a key is available
  --api-key <key>   default: $WORLDMONITOR_API_KEY
  --mcp-url <url>   default: ${DEFAULT_MCP_URL}
  --timeout <ms>    default: ${DEFAULT_TIMEOUT_MS}
  -h, --help

Exit codes: 0 success · 1 verification or write failure · 2 usage error`;

export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));

  let options;
  let config;
  try {
    options = parseArgs(argv);
    if (options.help || argv.length === 0) { stdout(`${HELP}\n`); return options.help ? 0 : 2; }
    config = resolveConfig(options, env);
    if (!options.printConfig && !options.write && !options.verify) {
      throw new UsageError('nothing to do — pass --print-config, --write or --verify');
    }
  } catch (error) {
    if (error instanceof UsageError) { stderr(`${error.message}\n\n${HELP}\n`); return 2; }
    throw error;
  }

  let failed = false;

  if (options.printConfig) {
    try {
      const client = options.printConfig;
      stdout(`${renderConfig(client, config)}\n`);
      stderr(`\nconfig file: ${CLIENTS[client].file}\n${CLIENTS[client].note}\n`);
    } catch (error) {
      if (error instanceof UsageError) { stderr(`${error.message}\n`); return 2; }
      throw error;
    }
  }

  if (options.write) {
    const client = options.client ?? 'claude-desktop';
    const readFile = io.readFile ?? (async (p) => {
      const { readFile: fsRead } = await import('node:fs/promises');
      try { return await fsRead(p, 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    });
    const writeFile = io.writeFile ?? (async (p, body) => {
      const { writeFile: fsWrite } = await import('node:fs/promises');
      await fsWrite(p, body, 'utf8');
    });

    try {
      const raw = await readFile(options.write);
      let existing = null;
      if (raw !== null && raw.trim() !== '') {
        try {
          existing = JSON.parse(raw);
        } catch {
          throw new UsageError(`${options.write} is not valid JSON — fix or move it first; refusing to overwrite`);
        }
        // Backup before touching a file the user already had.
        await writeFile(`${options.write}.bak`, raw);
      }
      const { merged, replaced } = mergeConfig(existing, client, config);
      await writeFile(options.write, `${JSON.stringify(merged, null, 2)}\n`);
      const others = Object.keys(merged.mcpServers).filter((k) => k !== SERVER_KEY);
      stderr(`${replaced ? 'updated' : 'added'} "${SERVER_KEY}" in ${options.write}`
        + `${raw !== null ? ` (backup: ${options.write}.bak)` : ''}`
        + `${others.length ? `; preserved: ${others.join(', ')}` : ''}\n`
        + `${CLIENTS[client].note}\n`);
    } catch (error) {
      if (error instanceof UsageError) { stderr(`${error.message}\n`); return 2; }
      stderr(`write failed: ${error.message}\n`);
      failed = true;
    }
  }

  if (options.verify) {
    const steps = await verify(config, io);
    stderr(`verifying ${config.mcpUrl}\n`);
    for (const step of steps) {
      stderr(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail ? ` — ${step.detail}` : ''}\n`);
    }
    if (steps.some((s) => !s.ok)) failed = true;
  }

  return failed ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
