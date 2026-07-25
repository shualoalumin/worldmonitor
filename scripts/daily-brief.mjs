#!/usr/bin/env node
// Daily intelligence brief generator — turns a set of World Monitor MCP tool
// calls into one Markdown (or JSON) document.
//
// WHY A SCRIPT AND NOT `worldmonitor <cmd>`: the CLI is one-call-per-invocation
// and prints raw JSON. A recurring brief needs the opposite shape — several
// tools fanned out under one auth/timeout budget, each response projected down
// to the few fields a human reads, and a single document that either lands in a
// file, a cron mail body, or a CI artifact. That composition is what lives here;
// the transport below is the same Streamable-HTTP MCP contract the CLI speaks.
//
// Payload discipline: every section sends a `jmespath` argument so the server
// projects the response BEFORE it crosses the wire (typically 80-95% smaller).
// A brief that pulled full bundles would spend most of its bytes on fields no
// reader sees, and on the Pro tier each call also costs daily quota.
//
// Failure model: sections are independent. One failing tool renders as an
// error line inside the brief and does not abort the others — a partial brief
// beats no brief when a single upstream is down. The process still exits 1 if
// ANY section failed, so a scheduler can alert on it while a human (or the
// artifact) still gets the document. Exit 2 is reserved for usage errors, so
// "you typed the flag wrong" is never confused with "the API had a bad day".
//
// Usage:
//   node scripts/daily-brief.mjs [options]
//
//   --api-key <key>     user API key (default: $WORLDMONITOR_API_KEY)
//   --mcp-url <url>     MCP endpoint (default: $WORLDMONITOR_MCP_URL or
//                       https://worldmonitor.app/mcp)
//   --sections <list>   comma-separated section ids (default: world,markets,
//                       conflicts,cyber,disasters). Use `--sections all` for
//                       every section. See SECTIONS below for the full list.
//   --countries <list>  comma-separated ISO 3166-1 alpha-2 codes. Adds a
//                       per-country block (brief + risk score) for each.
//   --format md|json    output format (default: md)
//   --out <path>        write to a file instead of stdout
//   --timeout <ms>      per-request timeout (default: 30000)
//   --limit <n>         max rows per list section (default: 5)
//   -h, --help
//
// Examples:
//   WORLDMONITOR_API_KEY=wm_xxx node scripts/daily-brief.mjs
//   node scripts/daily-brief.mjs --countries TW,KR,CN --sections world,markets
//   node scripts/daily-brief.mjs --format json --out brief.json

const DEFAULT_MCP_URL = 'https://worldmonitor.app/mcp';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 5;
const API_KEY_HEADER = 'X-WorldMonitor-Key';
const USER_AGENT = 'WorldMonitor-DailyBrief/1.0 (+https://worldmonitor.app)';
const DEFAULT_SECTIONS = ['world', 'markets', 'conflicts', 'cyber', 'disasters'];

class UsageError extends Error {}

// Section id → { title, tool, args(ctx), render(data) }.
//
// `jmespath` projections are part of the request, not a post-processing step:
// the server applies them, so the wire payload is already the shape `render`
// expects. Keep a projection and its renderer in sync — a projection that
// drops a field the renderer reads shows up as an empty cell, not an error.
const SECTIONS = {
  world: {
    title: 'Global Situation',
    tool: 'get_world_brief',
    args: () => ({ jmespath: '{summary: summary, headline: headline, updated: updated_at}' }),
    render: (data) => {
      const lines = [];
      if (data?.headline) lines.push(`**${data.headline}**`, '');
      if (data?.summary) lines.push(String(data.summary).trim());
      return lines.length ? lines.join('\n') : '_No brief text returned._';
    },
  },
  markets: {
    title: 'Markets',
    tool: 'get_market_data',
    args: () => ({ jmespath: 'data."stocks-bootstrap".quotes[].{symbol: symbol, price: price, change: changePercent}' }),
    render: (data, ctx) => table(
      ['Symbol', 'Price', 'Change %'],
      asRows(data, ctx.limit).map((q) => [q.symbol, fmtNum(q.price), fmtPct(q.change)]),
    ),
  },
  conflicts: {
    title: 'Conflict Events',
    tool: 'get_conflict_events',
    args: (ctx) => ({
      limit: ctx.limit,
      ...(ctx.countries.length === 1 ? { country: ctx.countries[0] } : {}),
      jmespath: 'events[].{date: event_date, country: country, type: event_type, fatalities: fatalities, note: notes}',
    }),
    render: (data, ctx) => table(
      ['Date', 'Country', 'Type', 'Fatalities'],
      asRows(data, ctx.limit).map((e) => [e.date, e.country, e.type, fmtNum(e.fatalities)]),
    ),
  },
  cyber: {
    title: 'Cyber Threats',
    tool: 'get_cyber_threats',
    args: (ctx) => ({
      limit: ctx.limit,
      jmespath: 'threats[].{severity: severity, type: threat_type, target: target_country, summary: summary}',
    }),
    render: (data, ctx) => table(
      ['Severity', 'Type', 'Target'],
      asRows(data, ctx.limit).map((t) => [fmtNum(t.severity), t.type, t.target]),
    ),
  },
  disasters: {
    title: 'Natural Disasters',
    tool: 'get_natural_disasters',
    args: (ctx) => ({
      limit: ctx.limit,
      jmespath: 'events[].{type: type, place: place, magnitude: magnitude, time: time}',
    }),
    render: (data, ctx) => table(
      ['Type', 'Place', 'Magnitude'],
      asRows(data, ctx.limit).map((e) => [e.type, e.place, fmtNum(e.magnitude)]),
    ),
  },
  news: {
    title: 'News Intelligence',
    tool: 'get_news_intelligence',
    args: (ctx) => ({
      limit: ctx.limit,
      jmespath: 'items[].{title: title, source: source, category: category, url: url}',
    }),
    render: (data, ctx) => asRows(data, ctx.limit)
      .map((n) => `- ${n.url ? `[${n.title}](${n.url})` : n.title}${n.source ? ` — ${n.source}` : ''}`)
      .join('\n') || '_No items._',
  },
  sanctions: {
    title: 'Sanctions',
    tool: 'get_sanctions_data',
    args: (ctx) => ({
      limit: ctx.limit,
      ...(ctx.countries.length === 1 ? { country: ctx.countries[0] } : {}),
      jmespath: 'designations[].{name: name, program: program, date: listed_on, country: country}',
    }),
    render: (data, ctx) => table(
      ['Name', 'Program', 'Country', 'Listed'],
      asRows(data, ctx.limit).map((d) => [d.name, d.program, d.country, d.date]),
    ),
  },
  forecasts: {
    title: 'Scenario Forecasts',
    tool: 'get_forecast_predictions',
    args: (ctx) => ({
      limit: ctx.limit,
      jmespath: 'forecasts[].{scenario: scenario, probability: probability, domain: domain, horizon: horizon}',
    }),
    render: (data, ctx) => table(
      ['Scenario', 'Probability', 'Domain', 'Horizon'],
      asRows(data, ctx.limit).map((f) => [f.scenario, fmtPct(f.probability), f.domain, f.horizon]),
    ),
  },
};

const COUNTRY_SECTIONS = {
  brief: {
    title: 'Brief',
    tool: 'get_country_brief',
    args: (_ctx, code) => ({ country_code: code, jmespath: '{summary: summary, headline: headline}' }),
    render: (data) => {
      const lines = [];
      if (data?.headline) lines.push(`**${data.headline}**`, '');
      if (data?.summary) lines.push(String(data.summary).trim());
      return lines.length ? lines.join('\n') : '_No brief text returned._';
    },
  },
  risk: {
    title: 'Risk',
    tool: 'get_country_risk',
    args: (_ctx, code) => ({ country_code: code, jmespath: '{score: score, band: band, trend: trend, updated: updated_at}' }),
    render: (data) => {
      if (!data || typeof data !== 'object') return '_No score returned._';
      const parts = [];
      if (data.score != null) parts.push(`score **${fmtNum(data.score)}**`);
      if (data.band) parts.push(`band **${data.band}**`);
      if (data.trend) parts.push(`trend **${data.trend}**`);
      return parts.length ? parts.join(' · ') : '_No score returned._';
    },
  },
};

// ─── formatting helpers ──────────────────────────────────────────────────────

// A projected list section can come back as a bare array or as a single object
// wrapping one (JMESPath multi-select on an empty source yields null). Normalize
// to an array so every renderer can assume rows.
function asRows(data, limit) {
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  return rows.filter(Boolean).slice(0, limit);
}

function fmtNum(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(value);
}

function fmtPct(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  // Probabilities arrive as 0..1, percent changes as ±n — scale only the former.
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  return `${pct > 0 ? '+' : ''}${Math.round(pct * 100) / 100}%`;
}

// Pipes inside a cell would split the column; escape them rather than dropping
// content (source names and scenario text legitimately contain '|').
function cell(value) {
  if (value == null || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—';
}

function table(headers, rows) {
  if (!rows.length) return '_No rows._';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

// ─── MCP transport ───────────────────────────────────────────────────────────

// The timeout covers BODY READ, not just response headers: an origin that sends
// headers then stalls the stream must fail the section, not hang the run. The
// AbortSignal aborts the body stream too, so the timer is held until the text
// is fully read.
async function mcpCall(config, tool, args) {
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
        [API_KEY_HEADER]: config.apiKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${tool}${response.status === 401 ? ' (check WORLDMONITOR_API_KEY and its tier)' : ''}`);
    }
    return unwrap(parseBody(text, response.headers), tool);
  } finally {
    clearTimeout(timer);
  }
}

// Streamable HTTP may answer as SSE; take the last `data:` frame. Anything that
// is not JSON at all comes back as the raw text so the caller can surface it.
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

// MCP wraps tool output in a content block whose text is itself JSON. Unwrap
// both layers so renderers see the projected object, and surface JSON-RPC
// errors as thrown Errors rather than rendering "[object Object]".
function unwrap(body, tool) {
  if (body && typeof body === 'object' && body.error) {
    throw new Error(`${tool}: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  const content = body?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return body?.result ?? body;
  const textBlock = content.find((c) => c?.type === 'text' && typeof c.text === 'string');
  if (!textBlock) return body.result;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return textBlock.text;
  }
}

// ─── argument parsing ────────────────────────────────────────────────────────

const VALUE_FLAGS = new Map([
  ['api-key', 'apiKey'], ['apikey', 'apiKey'], ['key', 'apiKey'],
  ['mcp-url', 'mcpUrl'],
  ['sections', 'sections'],
  ['countries', 'countries'], ['country', 'countries'],
  ['format', 'format'],
  ['out', 'out'],
  ['timeout', 'timeout'],
  ['limit', 'limit'],
]);

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') { options.help = true; continue; }
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const key = VALUE_FLAGS.get(name);
    if (!key) throw new UsageError(`unknown flag: ${token}`);
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`--${name} requires a value`);
    options[key] = value;
  }
  return options;
}

function splitList(value) {
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

export function resolveConfig(options, env = {}) {
  const apiKey = options.apiKey ?? env.WORLDMONITOR_API_KEY ?? '';
  if (!apiKey) {
    throw new UsageError('no API key — pass --api-key or set WORLDMONITOR_API_KEY (get one at https://worldmonitor.app/pro)');
  }

  const rawSections = options.sections ?? env.WORLDMONITOR_BRIEF_SECTIONS;
  const sections = !rawSections
    ? [...DEFAULT_SECTIONS]
    : rawSections === 'all'
      ? Object.keys(SECTIONS)
      : splitList(rawSections);
  const unknown = sections.filter((s) => !SECTIONS[s]);
  if (unknown.length) {
    throw new UsageError(`unknown section(s): ${unknown.join(', ')} — known: ${Object.keys(SECTIONS).join(', ')}`);
  }

  const countries = splitList(options.countries ?? env.WORLDMONITOR_BRIEF_COUNTRIES ?? '')
    .map((c) => c.toUpperCase());
  const bad = countries.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (bad.length) throw new UsageError(`invalid ISO 3166-1 alpha-2 code(s): ${bad.join(', ')}`);

  const format = options.format ?? 'md';
  if (format !== 'md' && format !== 'json') throw new UsageError(`--format must be md or json (got ${format})`);

  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`--timeout must be a positive number (got ${options.timeout})`);

  const limit = options.limit === undefined ? DEFAULT_LIMIT : Number(options.limit);
  if (!Number.isInteger(limit) || limit <= 0) throw new UsageError(`--limit must be a positive integer (got ${options.limit})`);

  return {
    apiKey,
    mcpUrl: options.mcpUrl ?? env.WORLDMONITOR_MCP_URL ?? DEFAULT_MCP_URL,
    sections,
    countries,
    format,
    out: options.out ?? env.WORLDMONITOR_BRIEF_OUT ?? '',
    timeout,
    limit,
  };
}

// ─── brief assembly ──────────────────────────────────────────────────────────

// Collects one result per requested section (plus two per country). Each entry
// carries either `data` or `error` — never both — so the renderers below can
// stay total, and `ok: false` on any entry drives the exit code.
export async function collect(config, call) {
  const results = [];
  for (const id of config.sections) {
    const section = SECTIONS[id];
    try {
      const data = await call(config, section.tool, section.args(config));
      results.push({ id, title: section.title, ok: true, data });
    } catch (error) {
      results.push({ id, title: section.title, ok: false, error: error.message });
    }
  }
  for (const code of config.countries) {
    for (const [key, section] of Object.entries(COUNTRY_SECTIONS)) {
      const id = `${code}:${key}`;
      try {
        const data = await call(config, section.tool, section.args(config, code));
        results.push({ id, country: code, kind: key, title: `${code} — ${section.title}`, ok: true, data });
      } catch (error) {
        results.push({ id, country: code, kind: key, title: `${code} — ${section.title}`, ok: false, error: error.message });
      }
    }
  }
  return results;
}

export function renderMarkdown(results, config, now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lines = [
    `# World Monitor Daily Brief`,
    '',
    `_Generated ${stamp} · sections: ${config.sections.join(', ') || 'none'}${config.countries.length ? ` · countries: ${config.countries.join(', ')}` : ''}_`,
    '',
  ];

  for (const result of results.filter((r) => !r.country)) {
    lines.push(`## ${result.title}`, '');
    lines.push(result.ok ? SECTIONS[result.id].render(result.data, config) : `> **Unavailable** — ${result.error}`);
    lines.push('');
  }

  const countryResults = results.filter((r) => r.country);
  if (countryResults.length) {
    lines.push('## Country Watch', '');
    for (const code of config.countries) {
      lines.push(`### ${code}`, '');
      for (const result of countryResults.filter((r) => r.country === code)) {
        lines.push(`**${COUNTRY_SECTIONS[result.kind].title}** — ${
          result.ok ? '' : `_unavailable: ${result.error}_`
        }`.trimEnd(), '');
        if (result.ok) lines.push(COUNTRY_SECTIONS[result.kind].render(result.data, config), '');
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    lines.push('---', '', `_${failed.length} of ${results.length} section(s) failed: ${failed.map((f) => f.id).join(', ')}_`, '');
  }

  return lines.join('\n');
}

export function renderJson(results, config, now = new Date()) {
  return JSON.stringify({
    generated_at: now.toISOString(),
    sections: config.sections,
    countries: config.countries,
    results: results.map(({ id, title, ok, data, error }) => ({ id, title, ok, ...(ok ? { data } : { error }) })),
  }, null, 2);
}

const HELP = `daily-brief — compose a World Monitor daily intelligence brief

  node scripts/daily-brief.mjs [options]

  --api-key <key>     user API key (default: $WORLDMONITOR_API_KEY)
  --mcp-url <url>     MCP endpoint (default: ${DEFAULT_MCP_URL})
  --sections <list>   ${Object.keys(SECTIONS).join(', ')} — or 'all'
                      (default: ${DEFAULT_SECTIONS.join(', ')})
  --countries <list>  ISO 3166-1 alpha-2 codes, e.g. TW,KR,CN
  --format md|json    output format (default: md)
  --out <path>        write to a file instead of stdout
  --timeout <ms>      per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --limit <n>         max rows per list section (default: ${DEFAULT_LIMIT})
  -h, --help

Exit codes: 0 success · 1 one or more sections failed · 2 usage error`;

export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const call = io.call ?? mcpCall;
  const writeFile = io.writeFile ?? (async (path, body) => {
    const { writeFile: fsWrite } = await import('node:fs/promises');
    await fsWrite(path, body, 'utf8');
  });

  let config;
  try {
    const options = parseArgs(argv);
    if (options.help) { stdout(`${HELP}\n`); return 0; }
    config = resolveConfig(options, env);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n\n${HELP}\n`);
      return 2;
    }
    throw error;
  }

  const results = await collect(config, call);
  const body = config.format === 'json'
    ? renderJson(results, config, io.now)
    : renderMarkdown(results, config, io.now);

  if (config.out) {
    await writeFile(config.out, `${body}\n`);
    stderr(`wrote ${config.out}\n`);
  } else {
    stdout(`${body}\n`);
  }

  return results.some((r) => !r.ok) ? 1 : 0;
}

// `import.meta.main` is Node 24+; the argv[1] comparison keeps the module
// importable by the tests on older runtimes without executing main().
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
