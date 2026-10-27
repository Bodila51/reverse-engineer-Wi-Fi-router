// Small shared helpers: paths, JSON files, redaction, timing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE = path.join(os.homedir(), '.cache', 'site-xray');

export const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    if (fallback !== undefined) return fallback;
    throw new Error(`cannot read ${file}`);
  }
};

export const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// Never let a token reach a log, a file or the screen.
export const redact = (s) =>
  String(s)
    .replace(/([?&](?:token|access_token|api_key|apikey|key)=)[^&#\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const runId = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export const identities = () => readJson(path.join(ROOT, 'identities.json'));

export const siteKey = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'site';
  }
};
