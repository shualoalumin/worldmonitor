// Offline coverage for scripts/daily-brief.mjs.
//
// The script's whole value is composition — several MCP tool calls fanned out
// under one budget, projected, and rendered into one document — so the tests
// inject the transport (`io.call`) and assert on the composition: argument
// validation, per-section failure isolation, the exit-code contract, and that
// every section's jmespath projection and renderer agree on field names.
//
// A live call is deliberately NOT exercised here: that surface is covered by
// .github/workflows/mcp-live-smoke.yml against production.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  collect,
  main,
  parseArgs,
  renderJson,
  renderMarkdown,
  resolveConfig,
} from '../scripts/daily-brief.mjs';

const KEY_ENV = { WORLDMONITOR_API_KEY: 'wm_test' };
const FIXED_NOW = new Date('2026-07-25T06:00:00.000Z');

function capture() {
  const out = [];
  const err = [];
  return {
    out, err,
    io: {
      env: KEY_ENV,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      now: FIXED_NOW,
    },
  };
}

// Stand-ins for what each projection yields — i.e. the shape AFTER the server
// applies the section's `jmespath`, which is what the transport hands back.
// Kept in step with the expressions in scripts/daily-brief.mjs, which are in
// turn written against the tools' outputSchema in api/mcp/registry/.
const FIXTURES = {
  get_world_brief: { brief: 'Nothing escalating.', summary: null, headlines: ['Quiet week'] },
  get_market_data: [
    { symbol: 'NVDA', price: 1234.5, change: 2.345 },
    // 0.5 is half a percent, not 50% — the regression this fixture pins.
    { symbol: 'TSM', price: 210.25, change: 0.5 },
    { symbol: 'ASML', price: 990, change: -0.25 },
  ],
  get_conflict_events: [{ date: 1769212800000, country: 'SD', type: 'state-based', deaths: 12 }],
  get_cyber_threats: [{ severity: 'high', type: 'ransomware', country: 'DE', indicator: 'evil.example' }],
  get_natural_disasters: [{ place: 'Off Honshu', magnitude: 5.8, depthKm: 40, at: 1769212800000 }],
  get_news_intelligence: [{ title: 'Fab | expansion', source: 'Reuters', url: 'https://example.com/a', threat: 'low', alert: false }],
  get_sanctions_data: [{ name: 'Acme LLC', country: 'RU', type: 'entity' }],
  get_forecast_predictions: [{ title: 'Strait closure', probability: 0.12, domain: 'maritime', region: 'MENA' }],
  get_country_brief: { brief: 'Fab output normal.', framework: 'default' },
  get_country_risk: { cii: 42, components: { unrest: 30, conflict: 12 } },
};

const okCall = async (_config, tool) => {
  if (!(tool in FIXTURES)) throw new Error(`test fixture missing for ${tool}`);
  return FIXTURES[tool];
};

describe('daily-brief argument parsing', () => {
  it('accepts the documented flags', () => {
    const options = parseArgs(['--sections', 'world,markets', '--countries', 'tw,kr', '--limit', '2', '--format', 'json']);
    assert.deepEqual(options, { sections: 'world,markets', countries: 'tw,kr', limit: '2', format: 'json' });
  });

  it('rejects unknown flags and bare arguments', () => {
    assert.throws(() => parseArgs(['--nope', 'x']), /unknown flag: --nope/);
    assert.throws(() => parseArgs(['world']), /unexpected argument: world/);
    assert.throws(() => parseArgs(['--sections']), /--sections requires a value/);
  });
});

describe('daily-brief config resolution', () => {
  it('defaults sections, format, timeout and limit', () => {
    const config = resolveConfig({}, KEY_ENV);
    assert.deepEqual(config.sections, ['world', 'markets', 'conflicts', 'cyber', 'disasters']);
    assert.equal(config.format, 'md');
    assert.equal(config.timeout, 30_000);
    assert.equal(config.limit, 5);
    assert.deepEqual(config.countries, []);
  });

  it('expands --sections all to every registered section', () => {
    const config = resolveConfig({ sections: 'all' }, KEY_ENV);
    assert.ok(config.sections.length > 5);
    assert.ok(config.sections.includes('sanctions'));
  });

  it('upper-cases country codes and rejects malformed ones', () => {
    assert.deepEqual(resolveConfig({ countries: 'tw, kr' }, KEY_ENV).countries, ['TW', 'KR']);
    assert.throws(() => resolveConfig({ countries: 'taiwan' }, KEY_ENV), /invalid ISO 3166-1 alpha-2/);
  });

  it('requires an API key', () => {
    assert.throws(() => resolveConfig({}, {}), /no API key/);
  });

  it('rejects an unknown section, format, timeout or limit', () => {
    assert.throws(() => resolveConfig({ sections: 'world,weather' }, KEY_ENV), /unknown section\(s\): weather/);
    assert.throws(() => resolveConfig({ format: 'yaml' }, KEY_ENV), /--format must be md or json/);
    assert.throws(() => resolveConfig({ timeout: '0' }, KEY_ENV), /--timeout must be a positive number/);
    assert.throws(() => resolveConfig({ limit: '1.5' }, KEY_ENV), /--limit must be a positive integer/);
  });

  it('reads defaults from the environment', () => {
    const config = resolveConfig({}, { ...KEY_ENV, WORLDMONITOR_BRIEF_SECTIONS: 'world', WORLDMONITOR_BRIEF_COUNTRIES: 'jp' });
    assert.deepEqual(config.sections, ['world']);
    assert.deepEqual(config.countries, ['JP']);
  });
});

describe('daily-brief collection', () => {
  it('collects one entry per section plus two per country', async () => {
    const config = resolveConfig({ sections: 'world,markets', countries: 'TW' }, KEY_ENV);
    const results = await collect(config, okCall);
    assert.deepEqual(results.map((r) => r.id), ['world', 'markets', 'TW:brief', 'TW:risk']);
    assert.ok(results.every((r) => r.ok));
  });

  it('isolates a failing section instead of aborting the run', async () => {
    const config = resolveConfig({ sections: 'world,markets,cyber' }, KEY_ENV);
    const results = await collect(config, async (cfg, tool) => {
      if (tool === 'get_market_data') throw new Error('HTTP 503 from get_market_data');
      return okCall(cfg, tool);
    });
    assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
    assert.match(results[1].error, /503/);
    assert.equal(results[1].data, undefined);
  });

  it('passes a single country through to the country-filterable sections', async () => {
    const seen = [];
    const config = resolveConfig({ sections: 'conflicts', countries: 'SD' }, KEY_ENV);
    await collect(config, async (cfg, tool, args) => {
      seen.push([tool, args]);
      return okCall(cfg, tool);
    });
    const conflictArgs = seen.find(([tool]) => tool === 'get_conflict_events')[1];
    assert.equal(conflictArgs.country, 'SD');
    assert.equal(conflictArgs.limit, 5);
  });

  it('omits the country filter when several countries are requested', async () => {
    const seen = [];
    const config = resolveConfig({ sections: 'conflicts', countries: 'SD,TW' }, KEY_ENV);
    await collect(config, async (cfg, tool, args) => {
      seen.push([tool, args]);
      return okCall(cfg, tool);
    });
    const conflictArgs = seen.find(([tool]) => tool === 'get_conflict_events')[1];
    assert.equal(conflictArgs.country, undefined);
  });

  it('sends a jmespath projection on every call so the server trims the payload', async () => {
    const config = resolveConfig({ sections: 'all', countries: 'TW' }, KEY_ENV);
    const missing = [];
    await collect(config, async (cfg, tool, args) => {
      if (!args.jmespath) missing.push(tool);
      return okCall(cfg, tool);
    });
    assert.deepEqual(missing, []);
  });
});

describe('daily-brief rendering', () => {
  it('renders markdown with a stamped header, tables and country blocks', async () => {
    const config = resolveConfig({ sections: 'world,markets', countries: 'TW', limit: '2' }, KEY_ENV);
    const md = renderMarkdown(await collect(config, okCall), config, FIXED_NOW);

    assert.match(md, /^# World Monitor Daily Brief/);
    assert.match(md, /_Generated 2026-07-25T06:00:00Z · sections: world, markets · countries: TW_/);
    assert.match(md, /- Quiet week/);
    assert.match(md, /Nothing escalating\./);
    assert.match(md, /\| Symbol \| Price \| Change % \|/);
    assert.match(md, /\| NVDA \| 1234\.5 \| \+2\.35% \|/);
    // --limit 2 must cut the third quote.
    assert.doesNotMatch(md, /ASML/);
    assert.match(md, /## Country Watch/);
    assert.match(md, /### TW/);
    assert.match(md, /CII \*\*42\*\*\/100/);
    assert.match(md, /unrest 30/);
  });

  it('keeps market changes in percentage points and probabilities as fractions', async () => {
    const config = resolveConfig({ sections: 'markets,forecasts' }, KEY_ENV);
    const md = renderMarkdown(await collect(config, okCall), config, FIXED_NOW);

    // The bug this pins: inferring the unit from magnitude rendered 0.5 as +50%.
    assert.match(md, /\| TSM \| 210\.25 \| \+0\.5% \|/);
    assert.doesNotMatch(md, /\+50%/);
    assert.match(md, /\| ASML \| 990 \| -0\.25% \|/);
    // Probabilities are 0..1 and DO scale.
    assert.match(md, /\| Strait closure \| 12% \|/);
  });

  it('renders epoch timestamps as dates', async () => {
    const config = resolveConfig({ sections: 'conflicts' }, KEY_ENV);
    const md = renderMarkdown(await collect(config, okCall), config, FIXED_NOW);
    assert.match(md, /\| 2026-01-24 \| SD \| state-based \| 12 \|/);
  });

  it('renders a failed section as an inline notice and a trailer', async () => {
    const config = resolveConfig({ sections: 'world,cyber' }, KEY_ENV);
    const results = await collect(config, async (cfg, tool) => {
      if (tool === 'get_cyber_threats') throw new Error('HTTP 401 (check WORLDMONITOR_API_KEY and its tier)');
      return okCall(cfg, tool);
    });
    const md = renderMarkdown(results, config, FIXED_NOW);
    assert.match(md, /> \*\*Unavailable\*\* — HTTP 401/);
    assert.match(md, /_1 of 2 section\(s\) failed: cyber_/);
  });

  it('escapes pipes so a cell cannot split a markdown column', async () => {
    const config = resolveConfig({ sections: 'news' }, KEY_ENV);
    const md = renderMarkdown(await collect(config, okCall), config, FIXED_NOW);
    assert.match(md, /\[Fab \\\| expansion\]\(https:\/\/example\.com\/a\)/);
  });

  it('fails a section whose projection returns null instead of printing an empty table', async () => {
    // A null projection means the expression did not match the response shape.
    // Rendering it as "No rows" would ship a confident, empty brief.
    const config = resolveConfig({ sections: 'markets,world' }, KEY_ENV);
    const results = await collect(config, async () => null);
    assert.deepEqual(results.map((r) => r.ok), [false, false]);
    for (const result of results) {
      assert.match(result.error, /projection returned null/);
      assert.match(result.error, /response shape does not match/);
    }
    const md = renderMarkdown(results, config, FIXED_NOW);
    assert.doesNotMatch(md, /_No rows\._/);
    assert.match(md, /_2 of 2 section\(s\) failed/);
  });

  it('still renders an empty list as "No rows" when the tool genuinely has none', async () => {
    const config = resolveConfig({ sections: 'markets' }, KEY_ENV);
    const results = await collect(config, async () => []);
    assert.equal(results[0].ok, true);
    assert.match(renderMarkdown(results, config, FIXED_NOW), /_No rows\._/);
  });

  it('fails a section whose projection returns the wrong container type', async () => {
    const config = resolveConfig({ sections: 'world' }, KEY_ENV);
    const results = await collect(config, async () => ['unexpected', 'array']);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /expected an object, got array/);
  });

  it('emits machine-readable json carrying per-section status', async () => {
    const config = resolveConfig({ sections: 'world,cyber', format: 'json' }, KEY_ENV);
    const results = await collect(config, async (cfg, tool) => {
      if (tool === 'get_cyber_threats') throw new Error('boom');
      return okCall(cfg, tool);
    });
    const parsed = JSON.parse(renderJson(results, config, FIXED_NOW));
    assert.equal(parsed.generated_at, FIXED_NOW.toISOString());
    assert.deepEqual(parsed.sections, ['world', 'cyber']);
    assert.equal(parsed.results[0].ok, true);
    assert.equal(parsed.results[1].ok, false);
    assert.equal(parsed.results[1].error, 'boom');
    assert.equal(parsed.results[1].data, undefined);
  });
});

describe('daily-brief exit codes', () => {
  it('returns 0 and prints the brief when every section succeeds', async () => {
    const { out, io } = capture();
    const code = await main(['--sections', 'world'], { ...io, call: okCall });
    assert.equal(code, 0);
    assert.match(out.join(''), /# World Monitor Daily Brief/);
  });

  it('returns 1 when any section fails but still emits the brief', async () => {
    const { out, io } = capture();
    const code = await main(['--sections', 'world,cyber'], {
      ...io,
      call: async (cfg, tool) => {
        if (tool === 'get_cyber_threats') throw new Error('upstream down');
        return okCall(cfg, tool);
      },
    });
    assert.equal(code, 1);
    assert.match(out.join(''), /Unavailable.*upstream down/);
  });

  it('returns 2 with usage text on a bad flag, and never calls the API', async () => {
    const { err, io } = capture();
    let called = false;
    const code = await main(['--sections', 'nope'], { ...io, call: async () => { called = true; } });
    assert.equal(code, 2);
    assert.equal(called, false);
    assert.match(err.join(''), /unknown section\(s\): nope/);
    assert.match(err.join(''), /daily-brief — compose/);
  });

  it('returns 2 when no API key is available', async () => {
    const { err, io } = capture();
    const code = await main([], { ...io, env: {}, call: async () => { throw new Error('should not be called'); } });
    assert.equal(code, 2);
    assert.match(err.join(''), /no API key/);
  });

  it('prints help without needing a key', async () => {
    const { out, io } = capture();
    const code = await main(['--help'], { ...io, env: {} });
    assert.equal(code, 0);
    assert.match(out.join(''), /Exit codes: 0 success/);
  });

  it('writes to --out instead of stdout', async () => {
    const { out, err, io } = capture();
    const writes = [];
    const code = await main(['--sections', 'world', '--out', 'brief.md'], {
      ...io,
      call: okCall,
      writeFile: async (path, body) => { writes.push([path, body]); },
    });
    assert.equal(code, 0);
    assert.equal(out.join(''), '');
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], 'brief.md');
    assert.match(writes[0][1], /# World Monitor Daily Brief/);
    assert.match(err.join(''), /wrote brief\.md/);
  });
});
