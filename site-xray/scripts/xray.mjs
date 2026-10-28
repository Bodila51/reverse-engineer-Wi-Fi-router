#!/usr/bin/env node
// site-xray: open a website as different visitors and see what it collects about each of them.
//
//   xray doctor
//   xray start <url> --as <identity> --run <dir> [--watch] [--headless] [--record]
//   xray look      --as <identity> --run <dir> [--find <text>]
//   xray click <i> --as <identity> --run <dir> [--phase <name>]
//   xray type <i> <text> --as <identity> --run <dir> [--phase <name>]
//   xray goto <url|link index> --as <identity> --run <dir> [--phase <name>]
//   xray scroll    --as <identity> --run <dir>
//   xray stop      --as <identity> --run <dir>
//   xray analyze   --run <dir>
//   xray report    --run <dir>
//   xray cost      --run <dir>
//   xray cleanup
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT, identities, readJson, redact, runId, sleep} from './lib/util.mjs';

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[k] = true;
    else {
      flags[k] = next;
      i++;
    }
  } else pos.push(a);
}
const cmd = pos.shift();
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const fail = (m) => {
  console.error(`xray: ${redact(m)}`);
  process.exit(1);
};

const runDir = () => {
  if (!flags.run) fail('--run <dir> is required');
  return path.resolve(String(flags.run));
};
const session = () => {
  if (!flags.as) fail('--as <identity> is required');
  const f = path.join(runDir(), String(flags.as), 'session.json');
  if (!fs.existsSync(f)) fail(`no running visit for ${flags.as}; start it first`);
  return readJson(f);
};
const call = async (name, body = {}) => {
  const s = session();
  const res = await fetch(`http://127.0.0.1:${s.port}/${name}`, {method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(180000)}).catch((e) => fail(`visit not reachable (${e.message}); it may have stopped`));
  return res.json();
};
const phase = () => (flags.phase ? String(flags.phase) : undefined);

switch (cmd) {
  case 'doctor': {
    const r = {node: process.version, nodeOk: Number(process.versions.node.split('.')[0]) >= 20};
    try {
      await import('playwright-core');
      await import('tldts');
      r.deps = 'ok';
    } catch {
      r.deps = 'missing: run npm install in ' + ROOT;
    }
    const chrome = ['/Applications/Google Chrome.app', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
    r.chrome = chrome.some((p) => fs.existsSync(p)) ? 'found' : 'not found (local mode needs Google Chrome)';
    const gl = await import('./lib/gologin.mjs');
    const tk = gl.token();
    r.gologinToken = !tk ? 'no' : gl.tokenLooksRight(tk) ? 'yes' : 'token looks wrong, save it again (see README)';
    if (r.gologinToken === 'yes') {
      try {
        const tr = await gl.traffic();
        r.gologinTraffic = tr.limitBytes != null ? `${((tr.usedBytes || 0) / 1e6).toFixed(0)} MB used of ${(tr.limitBytes / 1e6).toFixed(0)} MB` : 'unknown';
      } catch (e) {
        r.gologinTraffic = redact(e.message);
      }
    }
    r.identities = Object.keys(identities());
    out(r);
    break;
  }
  case 'start': {
    const url = pos[0];
    if (!url || !/^https?:\/\//.test(url)) fail('start needs a full http(s) URL');
    if (!flags.as) fail('--as <identity> is required');
    if (!identities()[flags.as]) fail(`unknown identity ${flags.as}; see identities.json`);
    const dir = runDir();
    const idDir = path.join(dir, String(flags.as));
    fs.mkdirSync(idDir, {recursive: true});
    const sFile = path.join(idDir, 'session.json');
    fs.rmSync(sFile, {force: true});
    const meta = path.join(dir, 'run.json');
    const run = readJson(meta, {runId: runId(), site: url, created: new Date().toISOString()});
    fs.writeFileSync(meta, JSON.stringify(run, null, 2));
    const log = fs.openSync(path.join(idDir, 'visit.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_serve', url, '--as', String(flags.as), '--run', dir, '--runid', run.runId, ...(flags.watch ? ['--watch'] : []), ...(flags.headless ? ['--headless'] : []), ...(flags.record ? ['--record'] : [])], {detached: true, stdio: ['ignore', log, log]});
    child.unref();
    const end = Date.now() + 180000;
    while (Date.now() < end) {
      if (fs.existsSync(sFile)) break;
      try {
        process.kill(child.pid, 0);
      } catch {
        fail(`the visit stopped while starting: ${redact(fs.readFileSync(path.join(idDir, 'visit.log'), 'utf8').trim().split('\n').slice(-3).join(' | '))}`);
      }
      await sleep(500);
    }
    if (!fs.existsSync(sFile)) fail('the visit did not start within 3 minutes');
    const s = readJson(sFile);
    const res = {started: flags.as, site: url, run: dir, firstLoad: s.first};
    if (flags.watch) {
      const lv = path.join(idDir, 'liveview.url');
      if (fs.existsSync(lv)) {
        try {
          execFileSync('open', [fs.readFileSync(lv, 'utf8').trim()]);
          res.liveView = 'opened in your browser';
        } catch {
          res.liveView = 'link saved, could not open it';
        }
      }
    }
    out(res);
    break;
  }
  case '_serve': {
    const {serve} = await import('./lib/capture.mjs');
    await serve({url: pos[0], identity: String(flags.as), runDir: String(flags.run), runId: String(flags.runid), watch: !!flags.watch, headless: !!flags.headless, record: !!flags.record}).catch((e) => {
      console.error(redact(e.stack || e.message));
      process.exit(1);
    });
    break;
  }
  case 'look':
    out(await call('look', flags.find ? {find: String(flags.find)} : {}));
    break;
  case 'click':
    out(await call('click', {i: pos[0], phase: phase()}));
    break;
  case 'type':
    out(await call('type', {i: pos[0], text: pos.slice(1).join(' '), phase: phase()}));
    break;
  case 'goto':
    if (!pos[0]) fail('goto needs a URL on the same site or a link index from look');
    out(await call('goto', {target: pos[0], phase: phase()}));
    break;
  case '_liveview-check':
    out(await call('liveviewcheck'));
    break;
  case 'scroll':
    out(await call('scroll', {phase: phase()}));
    break;
  case 'stop': {
    const r = await call('stop');
    if (r.summary) out(r.summary.join('\n'));
    else out(r);
    break;
  }
  case 'analyze': {
    const {analyze} = await import('./lib/analyze.mjs');
    out(await analyze(runDir()));
    break;
  }
  case 'report': {
    const {report} = await import('./lib/report.mjs');
    const file = await report(runDir());
    if (!flags['no-open']) {
      try {
        execFileSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [file]);
      } catch {}
    }
    out({report: file});
    break;
  }
  case 'cost': {
    const {cost} = await import('./lib/cost.mjs');
    out(await cost(runDir(), {since: flags.since}));
    break;
  }
  case 'cleanup': {
    const gl = await import('./lib/gologin.mjs');
    const done = gl.token() ? await gl.cleanup() : [];
    out({deletedGologinProfiles: done.length ? done : 'none'});
    break;
  }
  default:
    out(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
