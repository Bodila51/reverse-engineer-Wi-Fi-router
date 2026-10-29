// One visit = one background process that holds the browser and records everything.
// The scout drives it with short commands over a localhost-only HTTP port (see session.json).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import * as gl from './gologin.mjs';
import {ROOT, identities, redact, sleep, writeJson} from './util.mjs';

const MAX_BODY = 256 * 1024;
const MAX_PAGES = 5;

// Consent platforms, from script hosts and DOM containers.
const CMP = [
  ['OneTrust', /cookielaw\.org|onetrust\.com/, '#onetrust-banner-sdk, #onetrust-consent-sdk'],
  ['Cookiebot', /cookiebot\.com|cookiebot\.eu/, '#CybotCookiebotDialog'],
  ['Didomi', /privacy-center\.org|didomi\.io/, '#didomi-host, #didomi-notice'],
  ['Usercentrics', /usercentrics\.eu|usercentrics\.com/, '#usercentrics-root, #usercentrics-cmp-ui'],
  ['Quantcast', /quantcast\.mgr\.consensu\.org|cmp\.quantcast\.com|quantcast\.com\/choice/, '.qc-cmp2-container, #qc-cmp2-container'],
  ['Sourcepoint', /sourcepoint|sp-prod\.net|privacy-mgmt\.com/, '[id^="sp_message_container"]'],
  ['TrustArc', /trustarc\.com|truste\.com/, '#truste-consent-track, #truste-consent-content'],
  ['Google consent', /fundingchoicesmessages\.google\.com|consent\.google\.com/, '.fc-consent-root, .fc-dialog-container'],
  ['Complianz', /complianz/, '.cmplz-cookiebanner'],
  ['iubenda', /iubenda\.com/, '#iubenda-cs-banner'],
  ['Osano', /osano\.com/, '.osano-cm-window'],
  ['Ketch', /ketchcdn\.com|ketchjs/, '#lanyard_root'],
  ['Axeptio', /axept\.io/, '#axeptio_overlay'],
  ['CookieYes', /cookieyes\.com/, '.cky-consent-container'],
];
const CMP_SEL = CMP.map((c) => c[2]).join(',');
// Loose matches count only for a box that is not most of the page (some sites wrap the whole page in "cookieBanner").
const BANNER_SEL = [
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
  '[aria-label*="privacy" i]',
  '[role="dialog"]',
].join(',');

// Runs inside each frame: visible clickable or typeable elements, also inside open shadow roots.
const COLLECT = ([cmpSel, looseSel, find]) => {
  const bannerSel = [cmpSel, looseSel];
  const findRe = find ? new RegExp(find, 'i') : null;
  const out = [];
  const seen = new Set();
  const walk = (root) => {
    const els = root.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [onclick], [tabindex="0"]');
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      if (!findRe && !['INPUT', 'TEXTAREA'].includes(el.tagName) && (r.bottom < 0 || r.top > innerHeight * 3)) continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (el.tagName === 'INPUT' && ['hidden', 'submit', 'image'].includes(type) && !el.value) continue;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const name = `${el.name || ''} ${el.id || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('autocomplete') || ''}`.toLowerCase();
      const typeable = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type));
      let inBanner = false;
      try {
        let n = el;
        while (n && !inBanner) {
          if (n.matches && n.matches(bannerSel[0])) inBanner = true;
          else if (n.matches && n.matches(bannerSel[1]) && n.querySelectorAll('*').length < 600 && n.getBoundingClientRect().height < innerHeight * 0.9) inBanner = true;
          n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
        }
        // Unlabelled banners: a fixed or sticky box that talks about cookies or consent.
        n = el;
        while (n && !inBanner) {
          const pos = n.nodeType === 1 ? getComputedStyle(n).position : '';
          const txt = pos === 'fixed' || pos === 'sticky' ? (n.innerText || '').slice(0, 4000) : '';
          if (txt && /cookie|consent|einwillig|tracking|traceurs|rastreo/i.test(txt) && /accept|akzept|reject|ablehn|agree|einverstanden|allow|erlauben|essential|notwendig|refuser|rechazar|rifiut/i.test(txt)) inBanner = true;
          n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
        }
      } catch (e) {}
      if (findRe && !findRe.test(text)) continue;
      out.push({
        el,
        d: {
          text,
          role: el.getAttribute('role') || el.tagName.toLowerCase() + (type ? `:${type}` : ''),
          href: el.tagName === 'A' ? el.href : undefined,
          typeable,
          inBanner,
          isSearch: typeable && (type === 'search' || /search|suche|query|recherche|buscar|cerca|zoek|\bq\b|szuk|поиск/.test(name) || el.getAttribute('role') === 'searchbox'),
          isEmail: typeable && (type === 'email' || /e-?mail|newsletter/.test(name)),
          y: Math.round(r.top),
        },
      });
    }
    for (const n of root.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
  };
  walk(document);
  // Banner elements first, then search and email fields, then top to bottom.
  const rank = (d) => (d.inBanner ? 3 : 0) + (d.isSearch || d.isEmail ? 2 : 0) + (d.typeable ? 1 : 0);
  out.sort((a, b) => rank(b.d) - rank(a.d) || a.d.y - b.d.y);
  return out.slice(0, 60);
};

export async function serve({url, identity, runDir, runId, watch, headless, record}) {
  const idn = identities()[identity];
  if (!idn) throw new Error(`unknown identity ${identity}`);
  const dir = path.join(runDir, identity);
  fs.mkdirSync(path.join(dir, 'shots'), {recursive: true});
  const site = new URL(url);
  const started = Date.now();
  const cap = {
    tool: 'site-xray',
    site: site.href,
    identity,
    label: idn.label,
    mode: idn.mode,
    device: idn.device,
    country: idn.country,
    runId,
    canary: `xray-${runId}@example.com`,
    startedAt: new Date(started).toISOString(),
    endedAt: null,
    phase: 'first-load',
    phases: [{name: 'first-load', t: 0}],
    requests: [],
    websockets: [],
    fingerprint: [],
    actions: [],
    cookies: [],
    storage: {},
    consentPlatforms: [],
    screenshots: [],
    pageViews: 0,
    bannerSeen: false,
    blocked: false,
    problems: [],
    gologin: null,
  };
  const t = () => Date.now() - started;
  let lastNet = Date.now();
  let inflight = 0;

  // ---- browser
  let browser, ctx, tmpDir, profileId, lvBrowser, lvCdp;
  if (idn.mode === 'gologin') {
    const name = `site-xray-${identity}-${runId}`;
    profileId = await gl.createProfile({name, os: idn.os, country: idn.country, language: idn.language});
    cap.gologin = {profile: name, sessionStart: new Date().toISOString()};
    // Live View must be asked for before the preflight and the CDP connect (both start the session; asked after, Gologin answers 403 runByAnotherUser).
    if (watch || record) {
      try {
        const lv = await gl.liveView(profileId);
        cap.gologin.liveView = !!lv;
        if (lv && watch) fs.writeFileSync(path.join(dir, 'liveview.url'), lv);
        if (lv && record) {
          // Record the Live View page in a local headless browser. The link is never saved or printed.
          lvBrowser = await chromium.launch({channel: 'chrome', headless: true});
          const lvPage = await lvBrowser.newPage({viewport: {width: 1280, height: 800}});
          await lvPage.goto(lv, {waitUntil: 'domcontentloaded', timeout: 45000});
          fs.mkdirSync(path.join(dir, 'liveview'), {recursive: true});
          cap.liveviewFrames = [];
          lvCdp = await lvPage.context().newCDPSession(lvPage);
          lvCdp.on('Page.screencastFrame', ({data, sessionId}) => {
            const ms = t();
            const name = `${String(ms).padStart(7, '0')}.jpg`;
            try {
              fs.writeFileSync(path.join(dir, 'liveview', name), Buffer.from(data, 'base64'));
              cap.liveviewFrames.push({t: ms, file: `liveview/${name}`});
            } catch {}
            lvCdp.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
          });
          await lvCdp.send('Page.startScreencast', {format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2});
        }
      } catch (e) {
        cap.problems.push(`live view: ${redact(e.message.split('\n')[0]).replace(/https?:\/\/\S+/g, '[link]')}`);
      }
    }
    const pf = await gl.preflight(profileId);
    cap.gologin.preflight = pf.status;
    const giveUp = async (msg) => {
      await gl.endSession(profileId);
      await gl.deleteProfile(profileId).catch(() => {});
      throw new Error(msg);
    };
    if (pf.status === 403) await giveUp(`Gologin refused the session (403): ${pf.reason || 'token or plan'}`);
    if (pf.status === 503) await giveUp(`Gologin is at the parallel-session limit (503): ${pf.reason || ''}. Wait for another visit to stop.`);
    if (pf.status !== 200) await giveUp(`Gologin's browser did not start within 2 minutes (${pf.status}: ${pf.reason || ''})`);
    browser = await chromium.connectOverCDP(gl.connectUrl(profileId), {timeout: 90000}).catch((e) => giveUp(`could not connect to Gologin's browser: ${redact(e.message.split('\n')[0])}`));
    ctx = browser.contexts()[0] ?? (await browser.newContext());
    // Which country the site will see. Only the country code is kept, never the IP.
    try {
      const probe = await ctx.newPage();
      await probe.goto('https://www.cloudflare.com/cdn-cgi/trace', {timeout: 30000});
      const loc = /^loc=(\w+)$/m.exec(await probe.evaluate(() => document.body.innerText))?.[1];
      cap.gologin.exitCountry = loc ? loc.toLowerCase() : null;
      if (idn.country && loc && loc.toLowerCase() !== idn.country) cap.problems.push(`exit country is ${loc}, expected ${idn.country.toUpperCase()}`);
      await probe.close();
    } catch (e) {
      cap.problems.push(`country check: ${redact(e.message.split('\n')[0])}`);
    }
  } else {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `site-xray-${identity}-`));
    ctx = await chromium.launchPersistentContext(tmpDir, {channel: 'chrome', headless: !!headless, viewport: {width: 1366, height: 860}});
  }

  // ---- recorders, all attached before the first navigation
  await ctx.exposeBinding('__xrayFp', (src, ev) => {
    if (cap.fingerprint.length < 2000) cap.fingerprint.push({...ev, t: t(), phase: cap.phase});
  });
  await ctx.addInitScript({path: path.join(ROOT, 'scripts', 'lib', 'fp-hook.js')});

  const byReq = new Map();
  ctx.on('request', (req) => {
    lastNet = Date.now();
    inflight++;
    let post = null;
    try {
      const b = req.postDataBuffer();
      if (b) post = b.length > MAX_BODY ? b.subarray(0, MAX_BODY).toString('latin1') : b.toString('latin1');
    } catch {}
    let frameUrl = null;
    try {
      frameUrl = req.frame().url();
    } catch {}
    const r = {
      id: `r${cap.requests.length + 1}`,
      phase: cap.phase,
      t: t(),
      method: req.method(),
      url: req.url(),
      type: req.resourceType(),
      frameUrl,
      post,
      postTruncated: !!(post && post.length >= MAX_BODY),
      status: null,
      remoteIp: null,
      reqHeaders: null,
      resHeaders: null,
      mime: null,
      reqBytes: 0,
      resBytes: 0,
      failed: null,
      done: false,
    };
    cap.requests.push(r);
    byReq.set(req, r);
  });
  const finish = async (req, failed) => {
    const r = byReq.get(req);
    inflight = Math.max(0, inflight - 1);
    lastNet = Date.now();
    if (!r || r.done) return;
    r.done = true;
    if (failed) r.failed = req.failure()?.errorText || 'failed';
    try {
      r.reqHeaders = await req.allHeaders();
    } catch {}
    try {
      const res = await req.response();
      if (res) {
        r.status = res.status();
        r.resHeaders = await res.allHeaders().catch(() => null);
        r.mime = r.resHeaders?.['content-type'] || null;
        const addr = await res.serverAddr().catch(() => null);
        if (addr) r.remoteIp = addr.ipAddress;
      }
    } catch {}
    try {
      const s = await req.sizes();
      r.reqBytes = s.requestHeadersSize + s.requestBodySize;
      r.resBytes = s.responseHeadersSize + s.responseBodySize;
    } catch {}
  };
  ctx.on('requestfinished', (req) => finish(req, false));
  ctx.on('requestfailed', (req) => finish(req, true));

  const attachPage = (p) => {
    p.on('websocket', (ws) => {
      const w = {url: ws.url(), phase: cap.phase, t: t(), frames: 0, sample: []};
      cap.websockets.push(w);
      const add = (dir) => (f) => {
        w.frames++;
        const data = typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('latin1');
        const used = w.sample.reduce((n, s) => n + s.data.length, 0);
        if (used < 2048) w.sample.push({dir, phase: cap.phase, data: data.slice(0, 2048 - used)});
      };
      ws.on('framesent', add('sent'));
      ws.on('framereceived', add('received'));
    });
  };
  ctx.pages().forEach(attachPage);
  ctx.on('page', attachPage);
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // --record: the browser's own screen as JPEG frames (from the cloud browser, not this computer), kept across navigations.
  let cdp = null;
  if (record) {
    fs.mkdirSync(path.join(dir, 'frames'), {recursive: true});
    cap.frames = [];
    try {
      cdp = await ctx.newCDPSession(page);
      cdp.on('Page.screencastFrame', async ({data, sessionId}) => {
        const ms = t();
        const name = `${String(ms).padStart(7, '0')}.jpg`;
        try {
          fs.writeFileSync(path.join(dir, 'frames', name), Buffer.from(data, 'base64'));
          cap.frames.push({t: ms, file: `frames/${name}`, phase: cap.phase});
        } catch {}
        cdp.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
      });
      await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2});
    } catch (e) {
      cap.problems.push(`record: ${redact(e.message.split('\n')[0])}`);
    }
  }

  const settle = async (quietMs = 3000, maxMs = 25000) => {
    const end = Date.now() + maxMs;
    await sleep(500);
    while (Date.now() < end) {
      if (Date.now() - lastNet >= quietMs) break;
      await sleep(250);
    }
  };
  let shot = 0;
  const screenshot = async (tag) => {
    const file = path.join(dir, 'shots', `${String(++shot).padStart(2, '0')}-${tag}.png`);
    try {
      await page.screenshot({path: file, timeout: 15000});
      cap.screenshots.push(path.relative(dir, file));
      return file;
    } catch {
      return null;
    }
  };
  const setPhase = (name) => {
    if (name && name !== cap.phase) {
      cap.phase = name;
      cap.phases.push({name, t: t()});
    }
  };

  // ---- first load
  let navError = null;
  try {
    const res = await page.goto(site.href, {waitUntil: 'domcontentloaded', timeout: 45000});
    cap.pageViews = 1;
    if (res && [401, 403, 429, 503].includes(res.status())) cap.blocked = true;
  } catch (e) {
    navError = e.message.split('\n')[0];
    cap.problems.push(`first load: ${redact(navError)}`);
  }
  await settle();
  const firstShot = await screenshot('first-load');
  try {
    cap.browser = await page.evaluate(() => ({language: navigator.language, languages: navigator.languages, webdriver: navigator.webdriver, platform: navigator.platform, mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null, screen: `${screen.width}x${screen.height}`}));
  } catch {}
  try {
    const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000).toLowerCase());
    if (/access denied|attention required|verify you are human|are you a robot|unusual traffic|request blocked|captcha|pardon our interruption/.test(body) && body.length < 2500) cap.blocked = true;
  } catch {}

  // ---- command handlers
  let handles = [];
  const look = async ({find} = {}) => {
    for (const h of handles) h.handle.dispose().catch(() => {});
    handles = [];
    const items = [];
    for (const fr of page.frames()) {
      let host = '';
      try {
        host = new URL(fr.url()).hostname;
      } catch {}
      try {
        const arr = await fr.evaluateHandle(COLLECT, [CMP_SEL, BANNER_SEL, find || null]);
        const n = await arr.evaluate((a) => a.length);
        for (let i = 0; i < n && items.length < 120; i++) {
          const pair = await arr.evaluateHandle((a, i) => a[i], i);
          const d = await pair.evaluate((p) => p.d);
          const el = await pair.evaluateHandle((p) => p.el);
          const frameIsCmp = CMP.some((c) => c[1].test(host)) || /consent|cmp|privacy/.test(host);
          items.push({handle: el, frame: fr, d: {...d, frameHost: host !== site.hostname ? host : '', inBanner: d.inBanner || frameIsCmp}});
        }
        arr.dispose().catch(() => {});
      } catch {}
    }
    // Banner elements first, then search and email fields, then the rest top to bottom, max 40.
    const rank = (d) => (d.inBanner ? 3 : 0) + (d.isSearch || d.isEmail ? 2 : 0) + (d.typeable ? 1 : 0);
    items.sort((a, b) => rank(b.d) - rank(a.d) || a.d.y - b.d.y);
    handles = items.slice(0, 40);
    for (const x of items.slice(40)) x.handle.dispose().catch(() => {});
    const platforms = new Set(cap.consentPlatforms);
    const hosts = cap.requests.map((r) => r.url);
    for (const [name, re, sel] of CMP) {
      if (hosts.some((u) => re.test(u))) platforms.add(name);
      try {
        if (await page.locator(sel).first().count()) platforms.add(name);
      } catch {}
    }
    cap.consentPlatforms = [...platforms];
    if (handles.some((h) => h.d.inBanner)) cap.bannerSeen = true;
    const file = await screenshot('look');
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      consentPlatform: cap.consentPlatforms,
      bannerLikely: handles.some((h) => h.d.inBanner),
      blocked: cap.blocked,
      pageViews: cap.pageViews,
      elements: handles.map((h, i) => ({i, text: h.d.text, role: h.d.role, frameHost: h.d.frameHost || undefined, inBanner: h.d.inBanner || undefined, isSearch: h.d.isSearch || undefined, isEmail: h.d.isEmail || undefined, href: h.d.href ? redact(h.d.href).slice(0, 120) : undefined})),
      screenshot: file,
    };
  };
  const pick = (i) => {
    const h = handles[Number(i)];
    if (!h) throw new Error(`no element ${i}; run look first`);
    return h;
  };
  const navigated = async (before) => {
    if (page.url() !== before) cap.pageViews++;
  };
  const cmds = {
    look,
    async click({i, phase}) {
      const h = pick(i);
      if (h.d.href && cap.pageViews >= MAX_PAGES) throw new Error('page view limit reached (5)');
      if (/subscri|abonn|\bpay\b|purchase|buy|kaufen|€|£|\$/i.test(h.d.text)) throw new Error('that button leads to a payment or subscription: note "pay or accept" and click nothing');
      setPhase(phase);
      const before = page.url();
      cap.actions.push({t: t(), kind: 'click', text: h.d.text, inBanner: h.d.inBanner, phase: cap.phase});
      await h.handle.scrollIntoViewIfNeeded({timeout: 5000}).catch(() => {});
      // A consent banner often removes its own frame on click: "target closed" then means the click went through.
      await h.handle.click({timeout: 10000}).catch(async (e) => {
        if (/closed|detached/i.test(e.message)) return;
        await h.handle.evaluate((el) => el.click()).catch((e2) => {
          if (!/closed|detached/i.test(e2.message)) throw e2;
        });
      });
      await settle();
      await navigated(before);
      return {ok: true, url: page.url(), phase: cap.phase, screenshot: await screenshot('click')};
    },
    async type({i, text, phase}) {
      const h = pick(i);
      if (!h.d.typeable) throw new Error('that element does not take text');
      setPhase(phase);
      cap.actions.push({t: t(), kind: 'type', text: String(text).slice(0, 60), field: h.d.text, isEmail: h.d.isEmail, isSearch: h.d.isSearch, phase: cap.phase});
      if (h.d.isSearch) cap.searchWord = String(text);
      if (String(text) === cap.canary) cap.canaryTyped = true;
      await h.handle.click({timeout: 8000}).catch(() => {});
      await h.handle.fill('').catch(() => {});
      await h.handle.type(String(text), {delay: 60});
      // Never press Enter, never submit. Blur so input listeners fire.
      await h.handle.evaluate((el) => el.dispatchEvent(new Event('change', {bubbles: true}))).catch(() => {});
      await page.mouse.click(5, 5).catch(() => {});
      await settle(Math.max(3000, h.d.isEmail ? 8000 : 3000), 25000);
      return {ok: true, phase: cap.phase, screenshot: await screenshot('type')};
    },
    async goto({target, phase}) {
      if (cap.pageViews >= MAX_PAGES) throw new Error('page view limit reached (5)');
      let dest = target;
      if (/^\d+$/.test(String(target))) {
        const h = pick(target);
        if (!h.d.href) throw new Error('that element is not a link');
        dest = h.d.href;
      }
      const u = new URL(dest, page.url());
      if (u.hostname.replace(/^www\./, '').split('.').slice(-2).join('.') !== site.hostname.replace(/^www\./, '').split('.').slice(-2).join('.')) throw new Error('stay on the same site');
      if (/sign-?in|sign-?up|log-?in|register|account|auth|checkout|cart|basket|subscribe/i.test(u.hostname.split('.')[0] + u.pathname)) throw new Error('public pages only: pick an article, product or category, not a sign-in, account, cart or subscribe page');
      setPhase(phase);
      cap.actions.push({t: t(), kind: 'goto', url: u.href, phase: cap.phase});
      await page.goto(u.href, {waitUntil: 'domcontentloaded', timeout: 45000}).catch((e) => cap.problems.push(`goto: ${e.message.split('\n')[0]}`));
      cap.pageViews++;
      await settle();
      return {ok: true, url: page.url(), pageViews: cap.pageViews, screenshot: await screenshot('page')};
    },
    async scroll({phase}) {
      setPhase(phase);
      for (let k = 0; k < 4; k++) {
        await page.mouse.wheel(0, 900).catch(() => {});
        await sleep(600);
      }
      await settle(2000, 12000);
      return {ok: true, screenshot: await screenshot('scroll')};
    },
    // Smoke test only: does asking for a Live View link disturb the running CDP session?
    async liveviewcheck() {
      if (!profileId) throw new Error('Live View exists only for Gologin visits');
      writeJson(path.join(dir, 'capture.partial.json'), {requests: cap.requests.length});
      const out = {};
      try {
        const url = await gl.liveView(profileId);
        out.linkReturned = !!url;
        if (url) {
          const res = await fetch(url, {signal: AbortSignal.timeout(15000)}).catch(() => null);
          out.linkStatus = res ? res.status : 'no answer';
        }
      } catch (e) {
        out.error = redact(e.message);
      }
      try {
        out.evaluate = await page.evaluate(() => document.readyState);
        await page.goto(page.url(), {waitUntil: 'domcontentloaded', timeout: 30000});
        out.cdpAfter = 'yes';
      } catch (e) {
        out.cdpAfter = `no: ${redact(e.message.split('\n')[0])}`;
      }
      return out;
    },
    async stop() {
      setPhase('end');
      if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
      if (lvCdp) await lvCdp.send('Page.stopScreencast').catch(() => {});
      if (lvBrowser) await lvBrowser.close().catch(() => {});
      try {
        cap.cookies = await ctx.cookies();
      } catch (e) {
        cap.problems.push(`cookies: ${e.message}`);
      }
      for (const fr of page.frames()) {
        try {
          const s = await fr.evaluate(() => {
            const dump = (st) => {
              const o = {};
              try {
                for (let i = 0; i < st.length; i++) {
                  const k = st.key(i);
                  o[k] = String(st.getItem(k)).slice(0, 2000);
                }
              } catch (e) {}
              return o;
            };
            return {origin: location.origin, local: dump(localStorage), session: dump(sessionStorage)};
          });
          if (s.origin && s.origin !== 'null') cap.storage[s.origin] = {local: s.local, session: s.session};
        } catch {}
      }
      await sleep(1500);
      cap.endedAt = new Date().toISOString();
      cap.minutes = +((Date.now() - started) / 60000).toFixed(2);
      cap.bytes = cap.requests.reduce((n, r) => n + (r.reqBytes || 0) + (r.resBytes || 0), 0);
      try {
        await (browser ? browser.close() : ctx.close());
      } catch {}
      if (profileId) {
        cap.gologin.usageBeforeEnd = await gl.usage(profileId);
        await gl.endSession(profileId);
        cap.gologin.usage = await gl.usage(profileId);
        cap.gologin.sessionEnd = new Date().toISOString();
        await gl.deleteProfile(profileId).catch((e) => cap.problems.push(`delete profile: ${redact(e.message)}`));
      }
      if (tmpDir) fs.rmSync(tmpDir, {recursive: true, force: true});
      for (const r of cap.requests) delete r.done;
      writeJson(path.join(dir, 'capture.json'), cap);
      writeJson(path.join(dir, 'capture.har'), toHar(cap));
      const third = new Set(cap.requests.map((r) => hostOf(r.url)).filter((h) => h && !sameSite(h, site.hostname)));
      return {
        summary: [
          `${identity}: ${cap.requests.length} requests, ${cap.websockets.length} websockets`,
          `third-party hosts: ${third.size}`,
          `cookies: ${cap.cookies.length}`,
          `minutes: ${cap.minutes}`,
          `MB: ${(cap.bytes / 1e6).toFixed(2)}`,
        ],
        capture: path.join(dir, 'capture.json'),
      };
    },
  };

  // ---- control server
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const name = req.url.slice(1);
      let out;
      try {
        if (!cmds[name]) throw new Error(`unknown command ${name}`);
        out = await cmds[name](body ? JSON.parse(body) : {});
      } catch (e) {
        out = {ok: false, error: redact(e.message.split('\n')[0])};
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(out));
      if (name === 'stop' && out?.summary) setTimeout(() => process.exit(0), 200);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ready = {
    pid: process.pid,
    port: server.address().port,
    identity,
    site: site.href,
    first: {blocked: cap.blocked, error: navError ? redact(navError) : null, requests: cap.requests.length, screenshot: firstShot},
  };
  writeJson(path.join(dir, 'session.json'), ready);
  // A visit nobody drives for 15 minutes stops itself, so nothing is left running.
  let idle = Date.now();
  server.on('request', () => (idle = Date.now()));
  setInterval(async () => {
    if (Date.now() - idle > 15 * 60000) {
      await cmds.stop().catch(() => {});
      process.exit(0);
    }
  }, 30000).unref();
}

export const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};
const sameSite = (a, b) => a.replace(/^www\./, '').split('.').slice(-2).join('.') === b.replace(/^www\./, '').split('.').slice(-2).join('.');

function toHar(cap) {
  const hdrs = (h) => Object.entries(h || {}).map(([name, value]) => ({name, value: String(value)}));
  return {
    log: {
      version: '1.2',
      creator: {name: 'site-xray', version: '1.0.0'},
      pages: [{startedDateTime: cap.startedAt, id: 'page_1', title: cap.site, pageTimings: {}}],
      entries: cap.requests.map((r) => {
        let qs = [];
        try {
          qs = [...new URL(r.url).searchParams].map(([name, value]) => ({name, value}));
        } catch {}
        return {
          pageref: 'page_1',
          startedDateTime: new Date(Date.parse(cap.startedAt) + r.t).toISOString(),
          time: 0,
          _id: r.id,
          _phase: r.phase,
          _resourceType: r.type,
          request: {
            method: r.method,
            url: r.url,
            httpVersion: 'HTTP/1.1',
            headers: hdrs(r.reqHeaders),
            queryString: qs,
            cookies: [],
            headersSize: -1,
            bodySize: r.post ? r.post.length : 0,
            ...(r.post ? {postData: {mimeType: r.reqHeaders?.['content-type'] || '', text: r.post}} : {}),
          },
          response: {
            status: r.status || 0,
            statusText: r.failed || '',
            httpVersion: 'HTTP/1.1',
            headers: hdrs(r.resHeaders),
            cookies: [],
            content: {size: r.resBytes || 0, mimeType: r.mime || ''},
            redirectURL: '',
            headersSize: -1,
            bodySize: r.resBytes || 0,
          },
          cache: {},
          timings: {send: 0, wait: 0, receive: 0},
          ...(r.remoteIp ? {serverIPAddress: r.remoteIp} : {}),
        };
      }),
    },
  };
}
