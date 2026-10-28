// report.html: one self-contained page per run, readable on a phone.
import fs from 'node:fs';
import path from 'node:path';
import {readJson} from './util.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
// Nothing personal exists in these visits, but mask anything that looks like it anyway.
const mask = (s) =>
  String(s ?? '')
    .replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g, '$1.x')
    .replace(/[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/g, '***@***')
    .replace(/([?&](?:token|key|api_key)=)[^&]+/gi, '$1***');
const n = (x) => (x == null ? '–' : typeof x === 'number' ? x.toLocaleString('en-US') : x);
const usd = (x) => (x == null ? '–' : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);

export async function report(runDir) {
  const f = readJson(path.join(runDir, 'findings.json'));
  const fin = readJson(path.join(runDir, 'final.json'), null);
  const cost = readJson(path.join(runDir, 'cost.json'), null);
  const ev = new Map();
  if (fs.existsSync(path.join(runDir, 'evidence.jsonl')))
    for (const l of fs.readFileSync(path.join(runDir, 'evidence.jsonl'), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const e = JSON.parse(l);
      ev.set(e.eid, e);
    }
  const people = Object.entries(f.people);
  const pick = (check, kind) => f.checks.filter((c) => c.check === check && (!kind || c.kind === kind));
  const maxOf = (arr, fn) => (arr.length ? Math.max(...arr.map(fn)) : 0);

  const before = pick('before-consent', 'with an ID');
  const afterRej = pick('after-reject', 'with an ID');
  const rec = pick('session-recording');
  const fp = pick('fingerprinting');
  const canary = pick('canary-leak');
  const big = [
    ['companies received data', maxOf(people, ([, p]) => p.trackingCompanies), 'ad, analytics and tracking companies, most for one person'],
    ['before you clicked anything', before.length ? maxOf(before, (c) => c.companies.length) : people.some(([, p]) => p.banner) ? 0 : '–', 'companies that got an ID or cookies before any button'],
    ['after you clicked Reject', afterRej.length ? maxOf(afterRej, (c) => c.companies.length) : pick('after-reject').length || people.some(([, p]) => p.clicked === 'reject') ? 0 : '–', 'companies that still got an ID or cookies'],
    ['session recording', rec.length ? 'yes' : 'no', rec.length ? [...new Set(rec.flatMap((c) => c.companies))].join(', ') : 'no recording scripts seen'],
    ['fingerprinting scripts', fp.length ? new Set(fp.flatMap((c) => c.scripts.map((s) => s.script))).size : 0, 'scripts that read your device fingerprint'],
    ['typed email (never submitted)', canary.length ? (canary.some((c) => c.leaked) ? 'leaked' : 'stayed') : 'not tested', canary.some((c) => c.leaked) ? [...new Set(canary.flatMap((c) => c.companies))].join(', ') : 'checked as text and as md5, sha1, sha256'],
  ];

  const headlines = (fin?.headlines || []).filter((h) => h.status !== 'dropped');
  const companies = fin?.companies || f.companies;
  const steps = fin?.protect || defaultSteps;
  const ownerFix = fin?.ownerFix || [];

  const rawFor = (c) => {
    const ids = [];
    for (const e of ev.values()) if (e.company === c.name && ids.length < 3) ids.push(e);
    return ids;
  };

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site X-ray: ${esc(f.siteDomain)}</title>
<style>
:root{--bg:#fbfaf7;--ink:#16150f;--mute:#6d6a62;--line:#e6e2d9;--card:#fff;--red:#c4362b;--amber:#b5730a;--green:#2f7d4f;--chip:#f1eee6}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--ink:#efede7;--mute:#a19d93;--line:#2c2b27;--card:#1b1a18;--chip:#262521;--red:#ff7a6e;--amber:#e6a640;--green:#6cc490}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{max-width:1060px;margin:0 auto;padding:28px 16px 64px}h1{font-size:30px;line-height:1.15;margin:0 0 6px;letter-spacing:-.02em}h2{font-size:19px;margin:36px 0 12px}
.sub{color:var(--mute)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:20px}
.big{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.big b{display:block;font-size:30px;line-height:1.1;letter-spacing:-.02em}.big span{font-weight:600;font-size:13px}.big small{display:block;color:var(--mute);font-size:12px;margin-top:4px}
.hl{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--red);border-radius:10px;padding:12px 14px;margin:8px 0}.hl small{color:var(--mute)}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)}table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--mute);font-weight:600;white-space:nowrap}
.chip{display:inline-block;background:var(--chip);border-radius:20px;padding:1px 8px;font-size:12px;margin:1px 2px 1px 0}.y{color:var(--red);font-weight:600}.n{color:var(--green)}
details{margin:0}summary{cursor:pointer}pre{white-space:pre-wrap;word-break:break-all;font:12px/1.45 ui-monospace,Menlo,monospace;background:var(--chip);padding:8px;border-radius:8px;margin:6px 0}
ol li{margin:6px 0}.foot{color:var(--mute);font-size:12.5px;margin-top:36px}
</style></head><body><main>
<p class="sub">Site X-ray · ${esc(new Date(f.analyzedAt).toLocaleString('en-GB', {dateStyle: 'medium', timeStyle: 'short'}))}</p>
<h1>${esc(f.siteDomain)}</h1>
<p class="sub">Visited as ${people.length} ${people.length === 1 ? 'person' : 'people'}${countries(people)}. Public pages only, nothing submitted.</p>
<div class="grid">${big.map(([k, v, s]) => `<div class="big"><b>${esc(n(v))}</b><span>${esc(k)}</span><small>${esc(s)}</small></div>`).join('')}</div>

${headlines.length ? `<h2>What we found</h2>${headlines.map((h) => `<div class="hl">${esc(h.text)}<br><small>${esc(h.status === 'seen once' ? 'seen in one run only · ' : 'confirmed in two runs · ')}evidence: ${esc((h.evidence || []).slice(0, 6).join(', '))}</small></div>`).join('')}` : `<h2>What the checks found</h2>${f.checks.map((c) => `<div class="hl">${esc(c.summary)}<br><small>${esc(f.people[c.identity]?.label || c.identity)}${c.evidence?.length ? ` · evidence: ${esc(c.evidence.slice(0, 4).join(', '))}${c.evidence.length > 4 ? '…' : ''}` : ''}</small></div>`).join('')}`}

<h2>Each person</h2>
<div class="scroll"><table><tr><th></th>${people.map(([id, p]) => `<th>${esc(p.label || id)}</th>`).join('')}</tr>
${[
  ['Cookie banner', (p) => (p.banner ? `yes${p.consentPlatforms?.length ? ` (${p.consentPlatforms.join(', ')})` : ''}` : 'no')],
  ['Clicked', (p) => p.clicked],
  ['Blocked by the site', (p) => (p.blocked ? '<span class="y">yes</span>' : 'no')],
  ['Tracking companies', (p) => n(p.trackingCompanies)],
  ['All third parties', (p) => n(p.companies)],
  ['Before any click', (p) => n(p.beforeConsentCompanies)],
  ['Cookies', (p) => `${n(p.cookies)} (${n(p.thirdPartyCookies)} third-party)`],
  ['Longest cookie', (p) => `${n(p.longestCookieDays)} days`],
  ['Requests', (p) => n(p.requests)],
  ['Browser minutes · MB', (p) => `${n(p.minutes)} · ${n(p.mb)}`],
]
  .map(([k, fn]) => `<tr><th>${esc(k)}</th>${people.map(([, p]) => `<td>${fn(p)}</td>`).join('')}</tr>`)
  .join('')}
</table></div>
${(() => {
  // Only companies that reached at most half of the people: the real differences.
  const few = (f.differences || []).filter((d) => d.seenBy.length <= Math.max(1, Math.floor(people.length / 2))).slice(0, 10);
  return few.length ? `<p class="sub">Sent to only some people: ${few.map((d) => `<span class="chip">${esc(d.company)}: ${esc(d.seenBy.map((x) => shortLabel(f.people[x]?.label || x)).join(', '))}</span>`).join(' ')}</p>` : '';
})()}

<h2>Companies that received data</h2>
<div class="scroll"><table><tr><th>Company</th><th>What it does</th><th>HQ</th><th>What it received</th>${people.map(([id, p]) => `<th>${esc(shortLabel(p.label || id))}</th>`).join('')}</tr>
${companies
  .slice(0, 120)
  .map((c) => {
    const raw = rawFor(c);
    return `<tr><td><details><summary><b>${esc(c.name)}</b></summary>${raw.length ? raw.map((e) => `<pre>${esc(e.method)} ${esc(mask(e.url))}${e.post ? '\n\n' + esc(mask(e.post.slice(0, 600))) : ''}${e.decoded ? '\n\n' + esc(Object.entries(e.decoded.fields).map(([k, v]) => `${k}: ${mask(String(v).slice(0, 160))}`).join('\n')) : ''}</pre>`).join('') : `<small class="sub">${esc((c.domains || []).join(', '))}</small>`}</details></td><td>${esc(c.category)}</td><td>${esc(c.hq || '–')}</td><td>${(c.received || []).slice(0, 8).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</td>${people.map(([id]) => {
      const p = c.people?.[id];
      return `<td>${p ? `${p.requests}${p.beforeConsent ? ` <span class="y">(${p.beforeConsent} before click)</span>` : ''}` : '<span class="n">–</span>'}</td>`;
    }).join('')}</tr>`;
  })
  .join('')}
</table></div>

<h2>5 steps to protect yourself</h2>
<ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
${ownerFix.length ? `<h2>What the site owner should fix</h2><ol>${ownerFix.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}

${cost ? `<h2>What this check cost</h2><div class="scroll"><table><tr><th>Agent</th><th>Model</th><th>Job</th><th>Minutes</th><th>Tokens in / out</th><th>${esc('API price')}</th></tr>
${cost.agents.map((a) => `<tr><td>${esc(a.agent)}</td><td>${esc(a.model)}</td><td>${esc(a.job)}</td><td>${n(a.minutes)}</td><td>${n(a.tokens.input + a.tokens.cacheWrite + a.tokens.cacheRead)} / ${n(a.tokens.output)}</td><td>${usd(a.usd)}</td></tr>`).join('')}
<tr><td>Gologin Cloud Browser</td><td>${n(cost.browser.sessions)} sessions</td><td>browsers for the visitors</td><td>${n(cost.browser.minutes)}</td><td>${n(cost.browser.mb)} MB</td><td>${usd(cost.browser.usd)}</td></tr>
<tr><th>Total</th><th></th><th></th><th>${n(cost.total.minutes)}</th><th></th><th>${usd(cost.total.usd)}</th></tr></table></div>
<p class="sub">${esc(cost.priceLabel)}. ${esc(cost.notes.join(' '))}</p>` : ''}

<p class="foot">${f.notes.map(esc).join('<br>')}<br>Made with Site X-ray. Each finding links to the recorded requests in evidence.jsonl and capture.har in this folder.</p>
</main></body></html>`;
  const file = path.join(runDir, 'report.html');
  fs.writeFileSync(file, html);
  return file;
}

const countries = (people) => {
  const cs = [...new Set(people.map(([, p]) => p.country).filter(Boolean))];
  const name = {de: 'Germany', us: 'the US', gb: 'the UK'};
  return cs.length ? ` from ${cs.length === 1 ? name[cs[0]] || cs[0] : `${cs.length} countries`}` : '';
};
const shortLabel = (s) => s.split(',')[0];
const defaultSteps = [
  'Turn on tracker blocking: Firefox Enhanced Tracking Protection (Strict), Safari Advanced Tracking and Fingerprinting Protection, or the uBlock Origin Lite extension in Chrome.',
  'Click "Reject all" on cookie banners, then run this check again: if a site keeps sending ad requests after Reject, you can ask the site about it, or your data protection authority.',
  'Turn on Global Privacy Control (Firefox, Brave, DuckDuckGo browser) so sites get a "do not sell or share" signal on every visit.',
  'Delete cookies for a site when you leave it, or use a separate browser profile for shopping and news.',
  "Don't type your email into a page until you mean to send it: some scripts read form fields as you type.",
];
