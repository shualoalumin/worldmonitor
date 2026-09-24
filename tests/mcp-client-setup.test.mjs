// Offline coverage for scripts/mcp-client-setup.mjs.
//
// Two behaviours carry the risk and both are tested without network:
//   - --write must MERGE (other servers survive, a backup is taken, malformed
//     input is refused rather than silently replaced)
//   - --verify must not report success from anonymous discovery alone; the
//     tools/call step is what distinguishes a working key from a missing one
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEntry,
  main,
  mergeConfig,
  parseArgs,
  renderConfig,
  resolveConfig,
  verify,
} from '../scripts/mcp-client-setup.mjs';

const CONFIG = { mcpUrl: 'https://worldmonitor.app/mcp', apiKey: '', timeout: 15_000 };

function capture(env = {}) {
  const out = [];
  const err = [];
  return { out, err, io: { env, stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
}

describe('mcp-client-setup config rendering', () => {
  it('emits a native remote entry for url-based clients', () => {
    assert.deepEqual(buildEntry('claude-desktop', CONFIG), { url: CONFIG.mcpUrl });
    assert.deepEqual(buildEntry('cursor', CONFIG), { url: CONFIG.mcpUrl });
    assert.deepEqual(buildEntry('claude-code', CONFIG), { type: 'http', url: CONFIG.mcpUrl });
  });

  it('emits an mcp-remote stdio bridge with the key header as a single argument', () => {
    const entry = buildEntry('mcp-remote', { ...CONFIG, apiKey: 'wm_abc' });
    assert.equal(entry.command, 'npx');
    assert.ok(entry.args.includes('mcp-remote'));
    const headerIndex = entry.args.indexOf('--header');
    assert.equal(entry.args[headerIndex + 1], 'X-WorldMonitor-Key:wm_abc');
    // A space after the colon breaks argument escaping on Windows/Cursor.
    assert.doesNotMatch(entry.args[headerIndex + 1], /:\s/);
  });

  it('falls back to a placeholder key in the mcp-remote entry', () => {
    const entry = buildEntry('mcp-remote', CONFIG);
    assert.ok(entry.args.includes('X-WorldMonitor-Key:wm_YOUR_KEY'));
  });

  it('nests the entry under mcpServers.worldmonitor', () => {
    const parsed = JSON.parse(renderConfig('claude-desktop', CONFIG));
    assert.deepEqual(parsed, { mcpServers: { worldmonitor: { url: CONFIG.mcpUrl } } });
  });

  it('rejects an unknown client', () => {
    assert.throws(() => renderConfig('emacs', CONFIG), /unknown client: emacs/);
  });

  it('honours a custom endpoint', () => {
    const config = resolveConfig({ mcpUrl: 'https://staging.example/mcp' }, {});
    assert.deepEqual(buildEntry('claude-desktop', config), { url: 'https://staging.example/mcp' });
  });
});

describe('mcp-client-setup config merging', () => {
  it('preserves unrelated servers and unrelated top-level keys', () => {
    const existing = { theme: 'dark', mcpServers: { other: { url: 'https://other.example/mcp' } } };
    const { merged, replaced } = mergeConfig(existing, 'claude-desktop', CONFIG);
    assert.equal(replaced, false);
    assert.equal(merged.theme, 'dark');
    assert.deepEqual(merged.mcpServers.other, { url: 'https://other.example/mcp' });
    assert.deepEqual(merged.mcpServers.worldmonitor, { url: CONFIG.mcpUrl });
  });

  it('reports a replacement when the entry already exists', () => {
    const existing = { mcpServers: { worldmonitor: { url: 'https://old.example/mcp' } } };
    const { merged, replaced } = mergeConfig(existing, 'claude-desktop', CONFIG);
    assert.equal(replaced, true);
    assert.deepEqual(merged.mcpServers.worldmonitor, { url: CONFIG.mcpUrl });
  });

  it('creates the servers map when the config has none', () => {
    const { merged } = mergeConfig({}, 'claude-desktop', CONFIG);
    assert.deepEqual(Object.keys(merged.mcpServers), ['worldmonitor']);
  });

  it('refuses configs whose shape it would have to destroy', () => {
    assert.throws(() => mergeConfig([], 'claude-desktop', CONFIG), /not a JSON object/);
    assert.throws(() => mergeConfig({ mcpServers: [] }, 'claude-desktop', CONFIG), /"mcpServers" is not a JSON object/);
  });
});

describe('mcp-client-setup --write', () => {
  it('backs up an existing file and preserves other servers', async () => {
    const { err, io } = capture();
    const files = { '/tmp/cfg.json': JSON.stringify({ mcpServers: { other: { url: 'https://other.example/mcp' } } }, null, 2) };
    const writes = {};
    const code = await main(['--write', '/tmp/cfg.json'], {
      ...io,
      readFile: async (p) => files[p] ?? null,
      writeFile: async (p, body) => { writes[p] = body; },
    });
    assert.equal(code, 0);
    assert.ok(writes['/tmp/cfg.json.bak'], 'expected a .bak copy of the original');
    assert.deepEqual(JSON.parse(writes['/tmp/cfg.json.bak']), JSON.parse(files['/tmp/cfg.json']));
    const merged = JSON.parse(writes['/tmp/cfg.json']);
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['other', 'worldmonitor']);
    assert.match(err.join(''), /added "worldmonitor"/);
    assert.match(err.join(''), /preserved: other/);
  });

  it('creates a new file without a backup', async () => {
    const { err, io } = capture();
    const writes = {};
    const code = await main(['--write', '/tmp/new.json', '--client', 'claude-code'], {
      ...io,
      readFile: async () => null,
      writeFile: async (p, body) => { writes[p] = body; },
    });
    assert.equal(code, 0);
    assert.equal(writes['/tmp/new.json.bak'], undefined);
    assert.deepEqual(JSON.parse(writes['/tmp/new.json']).mcpServers.worldmonitor, { type: 'http', url: CONFIG.mcpUrl });
    assert.doesNotMatch(err.join(''), /backup/);
  });

  it('refuses to overwrite a file that is not valid JSON', async () => {
    const { err, io } = capture();
    const writes = {};
    const code = await main(['--write', '/tmp/broken.json'], {
      ...io,
      readFile: async () => '{ not json',
      writeFile: async (p, body) => { writes[p] = body; },
    });
    assert.equal(code, 2);
    assert.deepEqual(writes, {});
    assert.match(err.join(''), /not valid JSON/);
  });
});

describe('mcp-client-setup --verify', () => {
  const okRpc = async (_config, method) => {
    if (method === 'initialize') return { status: 200, body: { result: { serverInfo: { name: 'worldmonitor-mcp' } } } };
    if (method === 'tools/list') return { status: 200, body: { result: { tools: [{ name: 'get_market_data' }] } } };
    return { status: 200, body: { result: { content: [{ type: 'text', text: '"data"' }] } } };
  };

  it('walks initialize, tools/list and an authenticated tools/call', async () => {
    const steps = await verify({ ...CONFIG, apiKey: 'wm_abc' }, { rpc: okRpc });
    assert.deepEqual(steps.map((s) => s.name), ['initialize', 'tools/list', 'tools/call']);
    assert.ok(steps.every((s) => s.ok));
    assert.match(steps[0].detail, /worldmonitor-mcp/);
    assert.match(steps[1].detail, /1 tool\(s\)/);
  });

  it('sends the key only on tools/call, never on discovery', async () => {
    const seen = [];
    await verify({ ...CONFIG, apiKey: 'wm_abc' }, {
      rpc: async (config, method, _params, opts) => { seen.push([method, opts?.apiKey ?? null]); return okRpc(config, method); },
    });
    assert.deepEqual(seen.map(([, key]) => key), [null, null, 'wm_abc']);
  });

  it('skips the authenticated call when no key is available', async () => {
    const steps = await verify(CONFIG, { rpc: okRpc });
    assert.equal(steps.at(-1).name, 'tools/call');
    assert.equal(steps.at(-1).ok, true);
    assert.match(steps.at(-1).detail, /skipped/);
  });

  it('reports a rejected key with the tier hint instead of passing on discovery', async () => {
    const steps = await verify({ ...CONFIG, apiKey: 'wm_bad' }, {
      rpc: async (config, method) => (method === 'tools/call' ? { status: 401, body: '' } : okRpc(config, method)),
    });
    assert.equal(steps[1].ok, true, 'anonymous discovery still succeeds');
    assert.equal(steps.at(-1).ok, false);
    assert.match(steps.at(-1).detail, /401/);
    assert.match(steps.at(-1).detail, /free tier cannot/);
  });

  it('surfaces a JSON-RPC error body on the call step', async () => {
    const steps = await verify({ ...CONFIG, apiKey: 'wm_abc' }, {
      rpc: async (config, method) => (method === 'tools/call'
        ? { status: 200, body: { error: { message: 'quota exhausted' } } }
        : okRpc(config, method)),
    });
    assert.equal(steps.at(-1).ok, false);
    assert.equal(steps.at(-1).detail, 'quota exhausted');
  });

  it('stops after a failed initialize', async () => {
    const steps = await verify(CONFIG, { rpc: async () => ({ status: 502, body: '' }) });
    assert.deepEqual(steps.map((s) => s.name), ['initialize']);
    assert.equal(steps[0].ok, false);
  });

  it('reports a stall as a timeout rather than hanging', async () => {
    const steps = await verify(CONFIG, {
      rpc: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    });
    assert.equal(steps[0].ok, false);
    assert.match(steps[0].detail, /no response within 15000ms/);
  });

  it('exits 1 when a step fails and 0 when all pass', async () => {
    const failing = capture();
    assert.equal(await main(['--verify'], { ...failing.io, rpc: async () => ({ status: 502, body: '' }) }), 1);
    assert.match(failing.err.join(''), /FAIL initialize/);

    const passing = capture();
    assert.equal(await main(['--verify'], { ...passing.io, rpc: okRpc }), 0);
    assert.match(passing.err.join(''), /\bok\s+initialize/);
  });
});

describe('mcp-client-setup argument handling', () => {
  it('parses value and boolean flags', () => {
    assert.deepEqual(parseArgs(['--print-config', 'cursor', '--verify']), { printConfig: 'cursor', verify: true });
  });

  it('rejects unknown flags, bare arguments and missing values', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown flag: --nope/);
    assert.throws(() => parseArgs(['verify']), /unexpected argument: verify/);
    assert.throws(() => parseArgs(['--client']), /--client requires a value/);
  });

  it('rejects a non-positive timeout', () => {
    assert.throws(() => resolveConfig({ timeout: '-1' }, {}), /--timeout must be a positive number/);
  });

  it('prints help on --help and usage on no arguments', async () => {
    const helped = capture();
    assert.equal(await main(['--help'], helped.io), 0);
    assert.match(helped.out.join(''), /mcp-client-setup — configure and verify/);

    const bare = capture();
    assert.equal(await main([], bare.io), 2);
  });

  it('exits 2 when no action flag is given', async () => {
    const { err, io } = capture();
    assert.equal(await main(['--api-key', 'wm_abc'], io), 2);
    assert.match(err.join(''), /nothing to do/);
  });

  it('reads the key from the environment', async () => {
    const seen = [];
    const { io } = capture({ WORLDMONITOR_API_KEY: 'wm_env' });
    await main(['--verify'], {
      ...io,
      rpc: async (_config, method, _params, opts) => {
        seen.push(opts?.apiKey ?? null);
        if (method === 'initialize') return { status: 200, body: { result: { serverInfo: { name: 's' } } } };
        if (method === 'tools/list') return { status: 200, body: { result: { tools: [] } } };
        return { status: 200, body: { result: {} } };
      },
    });
    assert.equal(seen.at(-1), 'wm_env');
  });
});
