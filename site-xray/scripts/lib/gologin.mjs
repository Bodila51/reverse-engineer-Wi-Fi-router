// Gologin Cloud Browser over plain fetch (no Gologin SDK, so the repo stays MIT).
// Each visit gets its own temporary profile: its own device fingerprint and a residential IP in one country.
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {CACHE, readJson, writeJson, redact} from './util.mjs';

const API = 'https://api.gologin.com';
const CLOUD = 'https://cloudbrowser.gologin.com';
const LEDGER = path.join(CACHE, 'profiles.json');

// A Gologin API token is a JWT: starts with eyJ and has two dots.
export const tokenLooksRight = (t) => !!t && t.startsWith('eyJ') && (t.match(/\./g) || []).length === 2;

export function token() {
  if (process.env.GOLOGIN_TOKEN) return process.env.GOLOGIN_TOKEN.trim();
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'GOLOGIN_TOKEN', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const need = () => {
  const t = token();
  if (!t) throw new Error('No Gologin token. Copy it from your Gologin dashboard (API section), then run in Terminal: echo "Copy your Gologin token, come back here and press Enter"; read x; t="$(pbpaste)"; case "$t" in eyJ*) security add-generic-password -U -a "$USER" -s GOLOGIN_TOKEN -w "$t" && pbcopy < /dev/null && echo ok;; *) echo "The clipboard does not hold a Gologin token, try again";; esac');
  return t;
};

async function api(method, route, body, {ok404 = false} = {}) {
  const res = await fetch(API + route, {
    method,
    headers: {Authorization: `Bearer ${need()}`, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok && !(ok404 && res.status === 404)) {
    const msg = typeof data === 'object' && data ? (typeof data.message === 'string' ? data.message : JSON.stringify(data.message || data.error || data).slice(0, 300)) : String(data).slice(0, 200);
    throw new Error(`Gologin ${method} ${redact(route)} -> ${res.status}: ${redact(msg)}`);
  }
  return {status: res.status, data};
}

const ledger = () => readJson(LEDGER, []);
const saveLedger = (l) => writeJson(LEDGER, l);

export async function traffic() {
  const {data} = await api('GET', '/users-proxies/geolocation/traffic');
  const r = data?.residentTrafficData || data?.residentialTrafficData || {};
  return {usedBytes: r.trafficUsedBytes ?? null, limitBytes: r.trafficLimitBytes ?? null};
}

export async function createProfile({name, os, country, language}) {
  const {data} = await api('POST', '/browser/custom', {name, notes: '', os});
  const id = data?.id;
  if (!id) throw new Error('Gologin did not return a profile id');
  saveLedger([...ledger(), {id, name, created: new Date().toISOString()}]);
  // Current browser version for the fingerprint; not fatal if the plan doesn't allow it.
  await api('PATCH', '/browser/update_ua_to_new_browser_v', {
    browserIds: [id],
    updateUaToNewBrowserV: true,
    updateAllProfiles: false,
    testOrbita: false,
  }).catch(() => {});
  // Browser language: read the profile, change only the language, write it back.
  if (language) {
    try {
      const {data: prof} = await api('GET', `/browser/${id}`);
      prof.autoLang = false;
      prof.navigator = {...(prof.navigator || {}), language: `${language},${language.split('-')[0]};q=0.9`};
      await api('PUT', `/browser/${id}`, prof);
    } catch (e) {
      // Not fatal: the visit records navigator.language, so a mismatch shows up in the capture.
    }
  }
  if (country) {
    try {
      await api('POST', '/users-proxies/mobile-proxy', {countryCode: country, isDc: false, isMobile: false, profileIdToLink: id});
    } catch {
      await api('PATCH', `/browser/${id}/proxy`, {mode: 'gologin', autoProxyRegion: country});
    }
  }
  return id;
}

export const connectUrl = (id) => `wss://cloudbrowser.gologin.com/connect?token=${encodeURIComponent(need())}&profile=${id}`;

// The connect endpoint starts the cloud browser; answer 200 {"status":"ok"} once it is ready.
// 403 = token or plan, 503 = capacity or the parallel-session limit. Waits up to 2 minutes.
export async function preflight(id) {
  const end = Date.now() + 120000;
  let last = {status: 0, reason: 'no answer'};
  while (Date.now() < end) {
    try {
      const res = await fetch(`${CLOUD}/connect?token=${encodeURIComponent(need())}&profile=${id}`, {signal: AbortSignal.timeout(30000)});
      last = {status: res.status, reason: res.headers.get('x-error-reason') || null};
      if (res.status === 200 || res.status === 403) return last;
      if (res.status === 503 && /limit|parallel|concurren/i.test(last.reason || '')) return last;
    } catch (e) {
      last = {status: 0, reason: e.name === 'TimeoutError' ? 'still starting' : redact(e.message)};
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

export async function liveView(id) {
  const {data} = await api('POST', `/browser/${id}/web`, {});
  return data?.remoteOrbitaUrl || null;
}

export async function usage(id) {
  try {
    const {data} = await api('GET', `/cloud-usage/profile/${id}/stats`);
    return data;
  } catch (e) {
    return {error: redact(e.message)};
  }
}

export async function endSession(id) {
  await api('DELETE', `/browser/${id}/web`, undefined, {ok404: true}).catch(() => {});
}

export async function deleteProfile(id) {
  await api('DELETE', `/browser/${id}`, undefined, {ok404: true});
  saveLedger(ledger().filter((p) => p.id !== id));
}

// Deletes every temporary profile this tool created, also after a crash.
export async function cleanup() {
  const done = [];
  for (const p of ledger()) {
    await endSession(p.id);
    try {
      await deleteProfile(p.id);
      done.push(p.name);
    } catch (e) {
      done.push(`${p.name} (failed: ${redact(e.message)})`);
    }
  }
  // Leftovers that never made it into the ledger.
  try {
    const {data} = await api('GET', '/browser/v2?search=site-xray-');
    for (const p of data?.profiles || []) {
      if (String(p.name || '').startsWith('site-xray-')) {
        await endSession(p.id);
        await deleteProfile(p.id).catch(() => {});
        done.push(p.name);
      }
    }
  } catch {}
  return done;
}
