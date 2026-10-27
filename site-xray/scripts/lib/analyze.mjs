// Deterministic analysis of every visit in a run. Every finding points to request ids (evidence).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDomain} from 'tldts';
import {decode, params} from './decoders.mjs';
import {ROOT, identities, readJson, writeJson} from './util.mjs';

const TRACKING = new Set(['advertising', 'analytics', 'session recording', 'social', 'fingerprinting or bot protection']);
const ADLIKE = new Set(['advertising', 'analytics', 'session recording', 'social']);
const CONSENT_PARAM = /^(gdpr_consent|gdpr_pd|gpp|gpp_sid|addtl_consent|us_privacy|consent|tcf|euconsent|euconsent-v2|_body)$/i;
const SESSION_REC = /(^|\.)(clarity\.ms|hotjar\.(com|io)|fullstory\.com|smartlook\.(com|cloud)|mouseflow\.com|logrocket\.(com|io)|lr-ingest\.io|contentsquare\.net|contentsquare\.com|quantummetric\.com|inspectlet\.com|luckyorange\.(com|net)|crazyegg\.com)$/;
const WEBVISOR = /mc\.yandex\.(ru|com)\/webvisor/;
// Common tracker cookies set by script on the site's own domain, by owner.
const TRACKER_COOKIES = [
  [/^_ga($|_)|^_gid$|^_gat|^_gcl_|^__gads$|^__gpi$|^__eoi$|^FPID$|^FPLC$/, 'Google'],
  [/^_fbp$|^_fbc$/, 'Meta'],
  [/^_ttp$|^_tt_enable_cookie$|^ttcsid/, 'TikTok'],
  [/^_uetsid$|^_uetvid$|^_clck$|^_clsk$|^MUID$/, 'Microsoft'],
  [/^_hj/, 'Hotjar'],
  [/^_pin_unauth$|^_pinterest_/, 'Pinterest'],
  [/^_scid|^_sctr$/, 'Snap'],
  [/^_rdt_uuid$/, 'Reddit'],
  [/^li_fat_id$|^_li_dcdm|^lidc$|^bcookie$/, 'LinkedIn'],
  [/^cto_bundle$|^cto_/, 'Criteo'],
  [/^_ym_/, 'Yandex'],
  [/^ajs_(anonymous|user)_id$/, 'Segment'],
  [/^amplitude_id|^AMP_/, 'Amplitude'],
  [/^mp_.*_mixpanel$/, 'Mixpanel'],
  [/^_tq_id|^taboola/, 'Taboola'],
  [/^IDE$|^test_cookie$|^DSID$/, 'Google'],
];

function loadCompanies() {
  const db = readJson(path.join(ROOT, 'data', 'companies.json'), {companies: []});
  const map = new Map();
  for (const c of db.companies) {
    for (const d of c.domains || []) map.set(d.toLowerCase(), {name: c.name, category: c.category_by_domain?.[d] || c.category, hq: c.hq_country || null, hqSource: c.hq_source || null});
  }
  return (host) => {
    const parts = host.toLowerCase().split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const hit = map.get(parts.slice(i).join('.'));
      if (hit) return hit;
    }
    return null;
  };
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};
const pathOf = (u) => {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
};
const hash = (alg, s) => crypto.createHash(alg).update(s).digest('hex');

// Random-looking IDs: 12+ chars with letters and digits, or GA style 123456.789012.
const idTokens = (value) => {
  const out = new Set();
  for (const part of String(value).split(/[.|:=&;,\s"'{}[\]]+/)) {
    if (part.length >= 12 && part.length <= 200 && /[0-9]/.test(part) && /[a-zA-Z]/.test(part) && !/^https?/i.test(part) && !/^[a-z]+$/i.test(part)) out.add(part);
    if (/^\d{9,}$/.test(part)) out.add(part);
  }
  const ga = String(value).match(/\d{6,}\.\d{9,}/g);
  if (ga) ga.forEach((g) => out.add(g));
  return out;
};

export async function analyze(runDir) {
  const ids = identities();
  const company = loadCompanies();
  const run = readJson(path.join(runDir, 'run.json'), {});
  const visits = fs
    .readdirSync(runDir, {withFileTypes: true})
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(runDir, d.name, 'capture.json')))
    .map((d) => readJson(path.join(runDir, d.name, 'capture.json')));
  if (!visits.length) throw new Error('no finished visits in this run (stop each visit first)');

  const site = visits[0].site;
  const siteDomain = getDomain(hostOf(site)) || hostOf(site);
  const evidence = new Map();
  const checks = [];
  const companies = {};
  const people = {};

  const who = (host) => {
    const dom = getDomain(host) || host;
    if (dom === siteDomain) return {firstParty: true, name: siteDomain, category: 'the site itself', hq: null, domain: dom};
    const c = company(host);
    return c ? {...c, firstParty: false, domain: dom} : {firstParty: false, name: dom, category: 'unknown', hq: null, domain: dom};
  };
  const ev = (v, r, extra = {}) => {
    const eid = `${v.identity}:${r.id}`;
    if (!evidence.has(eid)) {
      const host = hostOf(r.url);
      const w = who(host);
      evidence.set(eid, {
        eid,
        identity: v.identity,
        id: r.id,
        t: r.t,
        phase: r.phase,
        method: r.method,
        url: r.url.length > 1500 ? r.url.slice(0, 1500) + '…' : r.url,
        host,
        company: w.name,
        category: w.category,
        status: r.status,
        cookieNames: cookieNames(r),
        post: r.post ? r.post.slice(0, 1500) : null,
        decoded: decode(r, host, pathOf(r.url)),
        ...extra,
      });
    }
    return eid;
  };
  const cookieNames = (r) => {
    const c = r.reqHeaders?.cookie;
    if (!c) return [];
    return c.split(/;\s*/).map((x) => x.split('=')[0]).filter(Boolean);
  };
  const carriesId = (r) => {
    if (cookieNames(r).length) return true;
    const ps = params(r);
    return ps.some(([k, v]) => /^(cid|uid|fbp|fbc|_fbp|guid|tdid|mid|vid|uuid|ttp|anonymous_id|user_id|userId|client_id|gclid|sid)$|\.anonymous_id$|\.ttp$/i.test(k) && v && v.length >= 6);
  };

  for (const v of visits) {
    const idn = ids[v.identity] || {};
    const consentClick = v.actions.find((a) => a.kind === 'click' && a.inBanner && /^after-(reject|accept)/.test(a.phase || ''));
    const tc = consentClick ? consentClick.t : null;
    const clicked = consentClick ? (consentClick.phase.startsWith('after-reject') ? 'reject' : 'accept') : 'nothing';
    const typedSearch = v.actions.find((a) => a.kind === 'type' && a.isSearch);
    const typedCanary = v.actions.find((a) => a.kind === 'type' && a.text && a.text.includes('@example.com'));
    const third = v.requests.filter((r) => {
      const h = hostOf(r.url);
      return h && !who(h).firstParty && !/^(data|blob|chrome-extension):/.test(r.url);
    });

    // per company: what it received, from whom
    for (const r of third) {
      const host = hostOf(r.url);
      const w = who(host);
      const c = (companies[w.name] ||= {name: w.name, category: w.category, hq: w.hq, hqSource: w.hqSource || null, domains: new Set(), people: {}, received: new Set(), requests: 0});
      c.domains.add(w.domain);
      c.requests++;
      const p = (c.people[v.identity] ||= {requests: 0, beforeConsent: 0, afterConsent: 0, first: r.id});
      p.requests++;
      if (tc != null && r.t < tc) p.beforeConsent++;
      if (tc != null && r.t >= tc) p.afterConsent++;
      const d = decode(r, host, pathOf(r.url));
      if (d) Object.keys(d.fields).forEach((k) => c.received.add(k));
      const ps = params(r);
      if (!d && ps.some(([, val]) => val && (val.includes(hostOf(site)) || val.includes(encodeURIComponent(site))))) c.received.add('page address');
      if (!d && ps.some(([k, val]) => !CONSENT_PARAM.test(k) && idTokens(val).size)) c.received.add('an ID');
      if (cookieNames(r).length) c.received.add('its own cookies');
      c.received.add('your IP address and browser details');
    }

    // 1. before consent
    if (v.bannerSeen && tc != null) {
      const pre = third.filter((r) => r.t < tc && ADLIKE.has(who(hostOf(r.url)).category));
      const withId = pre.filter(carriesId);
      const noId = pre.filter((r) => !carriesId(r));
      if (withId.length)
        checks.push({check: 'before-consent', identity: v.identity, kind: 'with an ID', companies: uniq(withId.map((r) => who(hostOf(r.url)).name)), count: withId.length, evidence: withId.slice(0, 60).map((r) => ev(v, r)), summary: `Before any button was clicked, ${uniq(withId.map((r) => who(hostOf(r.url)).name)).length} ad or analytics companies got requests carrying an ID or cookies.`});
      if (noId.length)
        checks.push({check: 'before-consent', identity: v.identity, kind: 'cookieless', companies: uniq(noId.map((r) => who(hostOf(r.url)).name)), count: noId.length, evidence: noId.slice(0, 60).map((r) => ev(v, r)), summary: `Before any button was clicked, ${noId.length} ad or analytics requests went out without cookies or an ID (page address and browser details only).`});
    }

    // 2. after reject
    if (clicked === 'reject') {
      const post = third.filter((r) => r.t >= tc && ADLIKE.has(who(hostOf(r.url)).category));
      const withId = post.filter(carriesId);
      const noId = post.filter((r) => !carriesId(r));
      if (withId.length)
        checks.push({check: 'after-reject', identity: v.identity, kind: 'with an ID', companies: uniq(withId.map((r) => who(hostOf(r.url)).name)), count: withId.length, evidence: withId.slice(0, 60).map((r) => ev(v, r)), summary: `After "Reject" was clicked, ${uniq(withId.map((r) => who(hostOf(r.url)).name)).length} ad or analytics companies still got requests carrying an ID or cookies.`});
      if (noId.length)
        checks.push({check: 'after-reject', identity: v.identity, kind: 'cookieless', companies: uniq(noId.map((r) => who(hostOf(r.url)).name)), count: noId.length, evidence: noId.slice(0, 60).map((r) => ev(v, r)), summary: `After "Reject", ${noId.length} ad or analytics requests went out without cookies or an ID.`});
      const left = v.cookies
        .map((c) => {
          const dom = c.domain.replace(/^\./, '');
          const w = who(dom);
          const owner = w.firstParty ? TRACKER_COOKIES.find(([re]) => re.test(c.name))?.[1] : ADLIKE.has(w.category) ? w.name : null;
          return owner ? {name: c.name, domain: c.domain, owner, days: c.expires > 0 ? Math.round((c.expires * 1000 - Date.parse(v.endedAt)) / 864e5) : 'session'} : null;
        })
        .filter(Boolean);
      if (left.length) checks.push({check: 'cookies-after-reject', identity: v.identity, count: left.length, cookies: left, companies: uniq(left.map((c) => c.owner)), evidence: [], summary: `${left.length} ad or analytics cookies were in the browser at the end of the visit, after "Reject".`});
    }

    // 3. search word leak
    if (typedSearch && v.searchWord) {
      const w = v.searchWord;
      const forms = uniq([w, encodeURIComponent(w), w.replace(/ /g, '+')]);
      const hits = third.filter((r) => r.t >= typedSearch.t && forms.some((f) => r.url.includes(f) || (r.post && r.post.includes(f))));
      if (hits.length) checks.push({check: 'search-leak', identity: v.identity, word: w, companies: uniq(hits.map((r) => who(hostOf(r.url)).name)), count: hits.length, evidence: hits.slice(0, 30).map((r) => ev(v, r)), summary: `The search word "${w}" was sent to ${uniq(hits.map((r) => who(hostOf(r.url)).name)).join(', ')}.`});
    }

    // 4. canary email leak (typed, never submitted)
    if (typedCanary) {
      const e = v.canary;
      const lower = e.trim().toLowerCase();
      const forms = [
        ['plain', e],
        ['url-encoded', encodeURIComponent(e)],
        ['base64', Buffer.from(e).toString('base64').replace(/=+$/, '')],
        ['md5', hash('md5', lower)],
        ['sha1', hash('sha1', lower)],
        ['sha256', hash('sha256', lower)],
      ];
      const hits = [];
      for (const r of third) {
        const hay = r.url + ' ' + (r.post || '');
        for (const [form, f] of forms) if (hay.includes(f) || hay.toLowerCase().includes(f.toLowerCase())) hits.push({r, form});
      }
      const wsHits = [];
      for (const w of v.websockets || []) {
        if (who(hostOf(w.url)).firstParty) continue;
        for (const s of w.sample) for (const [form, f] of forms) if (s.data.includes(f)) wsHits.push({url: w.url, form});
      }
      checks.push({
        check: 'canary-leak',
        identity: v.identity,
        leaked: hits.length + wsHits.length > 0,
        forms: uniq([...hits, ...wsHits].map((h) => h.form)),
        companies: uniq([...hits.map((h) => who(hostOf(h.r.url)).name), ...wsHits.map((h) => who(hostOf(h.url)).name)]),
        count: hits.length + wsHits.length,
        evidence: hits.slice(0, 30).map((h) => ev(v, h.r, {canaryForm: h.form})),
        websockets: wsHits.slice(0, 10),
        summary: hits.length + wsHits.length ? `An email address that was typed but never sent with the form reached ${uniq(hits.map((h) => who(hostOf(h.r.url)).name)).join(', ')} (${uniq(hits.map((h) => h.form)).join(', ')}).` : 'The typed email (never submitted) did not show up in any third-party request.',
      });
    }

    // 5. ID sync: an ID from one company's cookie or request turns up in a request to another company.
    const owned = new Map(); // token -> company
    for (const c of v.cookies) {
      const dom = c.domain.replace(/^\./, '');
      const w = who(dom);
      const owner = w.firstParty ? TRACKER_COOKIES.find(([re]) => re.test(c.name))?.[1] : TRACKING.has(w.category) ? w.name : null;
      if (!owner) continue;
      for (const tok of idTokens(c.value)) if (!site.includes(tok)) owned.set(tok, {owner, source: `cookie ${c.name}`});
    }
    const syncs = new Map();
    for (const r of third) {
      const w = who(hostOf(r.url));
      if (!TRACKING.has(w.category)) continue;
      // The shared consent string is not an ID sync: leave consent parameters out.
      const hay = params(r).filter(([k]) => !CONSENT_PARAM.test(k)).map(([k, x]) => `${k}=${x}`).join(' ') + ' ' + pathOf(r.url);
      for (const [tok, o] of owned) {
        if (o.owner === w.name || tok.length < 12) continue;
        if (hay.includes(tok)) {
          const k = `${o.owner}->${w.name}`;
          const s = syncs.get(k) || {from: o.owner, to: w.name, via: o.source, evidence: []};
          if (s.evidence.length < 5) s.evidence.push(ev(v, r, {syncedId: tok.slice(0, 6) + '…'}));
          syncs.set(k, s);
        }
      }
    }
    if (syncs.size) checks.push({check: 'id-sync', identity: v.identity, pairs: [...syncs.values()], companies: uniq([...syncs.values()].flatMap((s) => [s.from, s.to])), count: syncs.size, evidence: [...syncs.values()].flatMap((s) => s.evidence), summary: `${syncs.size} times an ID set by one company showed up in a request to a different company.`});

    // 6. session recording
    const rec = third.filter((r) => SESSION_REC.test(hostOf(r.url)) || WEBVISOR.test(r.url) || who(hostOf(r.url)).category === 'session recording');
    if (rec.length) {
      const after = clicked === 'reject' ? rec.filter((r) => r.t >= tc) : [];
      checks.push({check: 'session-recording', identity: v.identity, companies: uniq(rec.map((r) => who(hostOf(r.url)).name)), count: rec.length, afterReject: after.length, evidence: [...rec.slice(0, 10), ...after.slice(0, 10)].map((r) => ev(v, r)), summary: `Session recording script from ${uniq(rec.map((r) => who(hostOf(r.url)).name)).join(', ')} was loaded${after.length ? `, and it kept sending data after "Reject" (${after.length} requests)` : ''}.`});
    }

    // 7. fingerprinting (Englehardt & Narayanan 2016 criteria for canvas)
    const fp = [];
    for (const f of v.fingerprint) {
      const d = f.detail || {};
      let hit = null;
      if (f.api === 'canvas.read' && d.width >= 16 && d.height >= 16 && (d.colors >= 2 || d.chars >= 10) && (d.readW ?? 16) >= 16 && (d.readH ?? 16) >= 16 && !d.saveRestore && !d.listener) hit = 'canvas fingerprint';
      else if (f.api === 'webgl.unmasked') hit = 'reads the exact graphics card (WebGL)';
      else if (f.api === 'audio.render' && d.oscillator && d.compressor) hit = 'audio fingerprint';
      if (!hit) continue;
      const w = who(hostOf(f.script));
      fp.push({technique: hit, script: f.script.slice(0, 200), company: w.name, category: w.category, phase: f.phase, t: f.t, label: ADLIKE.has(w.category) ? 'tracking by fingerprint' : 'fingerprinting (can also be bot protection)'});
    }
    if (fp.length) checks.push({check: 'fingerprinting', identity: v.identity, scripts: dedupe(fp, (x) => x.technique + x.script), companies: uniq(fp.map((x) => x.company)), count: fp.length, evidence: [], summary: `${uniq(fp.map((x) => x.script)).length} scripts read device fingerprints: ${uniq(fp.map((x) => x.technique)).join(', ')}.`});

    // 8. per person
    const trackingCos = uniq(third.filter((r) => TRACKING.has(who(hostOf(r.url)).category)).map((r) => who(hostOf(r.url)).name));
    const allCos = uniq(third.map((r) => who(hostOf(r.url)).name));
    const lifetimes = v.cookies.map((c) => (c.expires > 0 ? (c.expires * 1000 - Date.parse(v.endedAt)) / 864e5 : 0));
    people[v.identity] = {
      label: v.label || idn.label,
      mode: v.mode,
      device: v.device,
      country: v.country,
      banner: v.bannerSeen,
      consentPlatforms: v.consentPlatforms,
      clicked,
      blocked: v.blocked,
      requests: v.requests.length,
      thirdPartyRequests: third.length,
      companies: allCos.length,
      trackingCompanies: trackingCos.length,
      trackingCompanyNames: trackingCos,
      beforeConsentCompanies: tc != null ? uniq(third.filter((r) => r.t < tc && ADLIKE.has(who(hostOf(r.url)).category)).map((r) => who(hostOf(r.url)).name)).length : null,
      cookies: v.cookies.length,
      thirdPartyCookies: v.cookies.filter((c) => !who(c.domain.replace(/^\./, '')).firstParty).length,
      longestCookieDays: lifetimes.length ? Math.round(Math.max(...lifetimes)) : 0,
      cookiesOverYear: lifetimes.filter((d) => d > 365).length,
      searchDone: !!typedSearch,
      canaryTyped: !!typedCanary,
      pageViews: v.pageViews,
      minutes: v.minutes,
      mb: +((v.bytes || 0) / 1e6).toFixed(2),
      problems: v.problems,
    };
  }

  // differences between people
  const list = Object.values(companies).map((c) => ({...c, domains: [...c.domains], received: [...c.received]}));
  const pids = Object.keys(people);
  const differences = list
    .filter((c) => TRACKING.has(c.category))
    .map((c) => ({company: c.name, seenBy: pids.filter((p) => c.people[p]), notSeenBy: pids.filter((p) => !c.people[p])}))
    .filter((d) => d.notSeenBy.length && d.seenBy.length);

  const findings = {
    tool: 'site-xray',
    site,
    siteDomain,
    runId: run.runId,
    analyzedAt: new Date().toISOString(),
    people,
    checks,
    companies: list.sort((a, b) => Number(TRACKING.has(b.category)) - Number(TRACKING.has(a.category)) || b.requests - a.requests),
    differences,
    notes: [
      'A company "received data" when the browser sent it any request: that always includes your IP address and browser details.',
      'Cookieless pings are listed apart from requests with cookies or IDs.',
      'Some fingerprinting is used for bot protection; it is labelled by the owner of the script.',
      'Company HQ countries come only from data/companies.json and the auditor; unknown stays unknown.',
    ],
  };
  writeJson(path.join(runDir, 'findings.json'), findings);
  fs.writeFileSync(path.join(runDir, 'evidence.jsonl'), [...evidence.values()].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return {
    findings: path.join(runDir, 'findings.json'),
    evidence: path.join(runDir, 'evidence.jsonl'),
    people: Object.fromEntries(Object.entries(people).map(([k, p]) => [k, `${p.trackingCompanies} tracking companies, ${p.companies} third parties, banner ${p.banner ? 'yes' : 'no'}, clicked ${p.clicked}${p.blocked ? ', BLOCKED' : ''}`])),
    checks: checks.map((c) => `${c.identity} ${c.check}${c.kind ? ` (${c.kind})` : ''}: ${c.summary}`),
  };
}

const uniq = (a) => [...new Set(a.filter(Boolean))];
const dedupe = (a, key) => {
  const m = new Map();
  for (const x of a) if (!m.has(key(x))) m.set(key(x), x);
  return [...m.values()];
};
