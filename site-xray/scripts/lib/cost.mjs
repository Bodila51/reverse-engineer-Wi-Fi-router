// Real cost of a run: tokens from Claude Code's own transcripts, browser minutes and MB from the visits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ROOT, readJson, writeJson} from './util.mjs';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Find agent-<id>.jsonl anywhere under ~/.claude/projects/<project>/<session>/subagents/.
function findAgentFile(agentId) {
  if (!fs.existsSync(PROJECTS)) return null;
  for (const proj of fs.readdirSync(PROJECTS)) {
    const pdir = path.join(PROJECTS, proj);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const ses of fs.readdirSync(pdir)) {
      const f = path.join(pdir, ses, 'subagents', `agent-${agentId}.jsonl`);
      if (fs.existsSync(f)) return {file: f, session: ses, project: pdir};
    }
  }
  return null;
}

// Count each message id once (the last line wins), at its own model's price.
function usageOf(file, {from, to} = {}) {
  const byId = new Map();
  let first = null;
  let last = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'assistant' || !d.message?.usage) continue;
    const ts = Date.parse(d.timestamp);
    if (from && ts < from) continue;
    if (to && ts > to) continue;
    first = first == null ? ts : Math.min(first, ts);
    last = last == null ? ts : Math.max(last, ts);
    byId.set(d.message.id || `${d.uuid}`, {model: d.message.model, usage: d.message.usage});
  }
  return {messages: [...byId.values()], first, last};
}

function price(prices, model, u) {
  const key = Object.keys(prices.models).find((k) => model && model.startsWith(k));
  if (!key) return null;
  let p = prices.models[key];
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (p.over_100k && prompt > 100000) p = {...p, ...p.over_100k};
  if (u.speed === 'fast' && p.fast) p = {...p, ...p.fast};
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const w5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  return ((u.input_tokens || 0) * p.input + w5m * p.write_5m + w1h * p.write_1h + (u.cache_read_input_tokens || 0) * p.cache_read + (u.output_tokens || 0) * p.output) / 1e6;
}

function sum(prices, msgs) {
  const t = {model: null, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, usd: 0, unpriced: 0};
  const models = new Set();
  for (const {model, usage: u} of msgs) {
    models.add(model);
    t.input += u.input_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.output += u.output_tokens || 0;
    const p = price(prices, model, u);
    if (p == null) t.unpriced++;
    else t.usd += p;
  }
  t.model = [...models].filter(Boolean).join(', ');
  t.usd = +t.usd.toFixed(4);
  return t;
}

export async function cost(runDir) {
  const prices = readJson(path.join(ROOT, 'prices.json'));
  const run = readJson(path.join(runDir, 'run.json'), {});
  const agents = readJson(path.join(runDir, 'agents.json'), {agents: []});
  const visits = fs
    .readdirSync(runDir, {withFileTypes: true})
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(runDir, d.name, 'capture.json')))
    .map((d) => readJson(path.join(runDir, d.name, 'capture.json')));
  const from = Date.parse(run.created || visits[0]?.startedAt || 0);
  const rows = [];
  let session = null;
  let runEnd = Math.max(0, ...visits.map((v) => Date.parse(v.endedAt) || 0));
  const notes = [];

  for (const a of agents.agents || []) {
    const f = findAgentFile(a.agentId);
    if (!f) {
      notes.push(`no transcript found for agent ${a.agentId} (${a.role})`);
      continue;
    }
    session ||= f;
    const u = usageOf(f.file);
    if (u.last) runEnd = Math.max(runEnd, u.last);
    const s = sum(prices, u.messages);
    rows.push({agent: a.role + (a.identity ? ` (${a.identity})` : ''), role: a.role, model: s.model, job: a.job || '', minutes: u.first ? +((u.last - u.first) / 60000).toFixed(1) : 0, tokens: {input: s.input, cacheWrite: s.cacheWrite, cacheRead: s.cacheRead, output: s.output}, usd: s.usd});
  }
  // The orchestrator is the main session, counted only inside the run window.
  if (session) {
    const main = path.join(session.project, `${session.session}.jsonl`);
    if (fs.existsSync(main)) {
      // Only the run's own window (run start to the last agent or visit), so runs are comparable.
      const u = usageOf(main, {from, to: runEnd || undefined});
      const s = sum(prices, u.messages);
      rows.unshift({agent: 'orchestrator (run window)', role: 'orchestrator', model: s.model, job: 'plans the run, starts the agents, writes the report', minutes: u.first ? +((u.last - u.first) / 60000).toFixed(1) : 0, tokens: {input: s.input, cacheWrite: s.cacheWrite, cacheRead: s.cacheRead, output: s.output}, usd: s.usd});
    } else notes.push('main session transcript not found');
  } else if (!(agents.agents || []).length) notes.push('no agents.json in the run: token cost not counted');

  const g = prices.gologin || {};
  const cloud = visits.filter((v) => v.mode === 'gologin');
  const browser = {
    sessions: cloud.length,
    minutes: +cloud.reduce((n, v) => n + (v.minutes || 0), 0).toFixed(2),
    mb: +(cloud.reduce((n, v) => n + (v.bytes || 0), 0) / 1e6).toFixed(2),
    localVisits: visits.length - cloud.length,
    usd: null,
  };
  if (g.per_browser_hour != null) browser.usd = +((browser.minutes / 60) * g.per_browser_hour + (g.per_gb_residential != null ? (browser.mb / 1000) * g.per_gb_residential : 0)).toFixed(4);
  else if (cloud.length) notes.push('Gologin rates not set in prices.json: browser shown in minutes and MB only');

  const tokensUsd = +rows.reduce((n, r) => n + r.usd, 0).toFixed(4);
  const out = {
    priceLabel: 'API price (list price of the tokens used; a subscription bills differently)',
    pricesChecked: prices.checked,
    agents: rows,
    browser,
    total: {tokensUsd, browserUsd: browser.usd, usd: +(tokensUsd + (browser.usd || 0)).toFixed(4), minutes: runEnd ? +((runEnd - from) / 60000).toFixed(1) : null},
    notes,
  };
  writeJson(path.join(runDir, 'cost.json'), out);
  return out;
}
