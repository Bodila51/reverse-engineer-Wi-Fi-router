// Turn known tracker requests into plain words. Unknown endpoints get their parameters listed as seen.

// All parameters of a request: URL query + form or JSON body (flattened), GA4 batches split into hits.
export function params(r) {
  const out = [];
  let u;
  try {
    u = new URL(r.url);
  } catch {
    return out;
  }
  for (const [k, v] of u.searchParams) out.push([k, v]);
  const body = r.post;
  if (body) {
    const s = body.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        flatten(JSON.parse(s), '', out);
      } catch {
        out.push(['_body', s.slice(0, 2000)]);
      }
    } else if (/^[\w.%[\]-]+=/.test(s)) {
      for (const line of s.split(/\r?\n/)) {
        try {
          for (const [k, v] of new URLSearchParams(line)) out.push([k, v]);
        } catch {}
      }
    } else if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s.slice(0, 500))) out.push(['_body', s.slice(0, 2000)]);
    else out.push(['_body', `[binary, ${s.length} bytes]`]);
  }
  return out;
}

function flatten(v, prefix, out, depth = 0) {
  if (depth > 6 || out.length > 400) return;
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out.push([prefix, String(v)]);
}

const get = (ps, ...keys) => {
  for (const k of keys) {
    const hit = ps.find(([n]) => n === k);
    if (hit) return hit[1];
  }
  return undefined;
};

// gcs: undocumented Google consent flag. Common reading: G1 + ad_storage + analytics_storage.
export function gcsWords(gcs) {
  if (!gcs) return null;
  const m = /^G1([01])([01])$/.exec(gcs);
  if (!m) return `Google's consent flag in the request: ${gcs}`;
  const w = (b) => (b === '1' ? 'granted' : 'denied');
  return `Google's consent flag in the request: ads ${w(m[1])}, analytics ${w(m[2])} (gcs=${gcs})`;
}

const D = [
  {
    name: 'Google Analytics 4',
    test: (h, p) => /(^|\.)google-analytics\.com$|(^|\.)analytics\.google\.com$/.test(h) && /\/g\/collect/.test(p),
    fields: (ps) => ({
      event: get(ps, 'en'),
      'page address': get(ps, 'dl'),
      'page title': get(ps, 'dt'),
      'came from (referrer)': get(ps, 'dr'),
      'browser ID (cid)': get(ps, 'cid'),
      'session ID (sid)': get(ps, 'sid'),
      'user ID (uid)': get(ps, 'uid'),
      language: get(ps, 'ul'),
      screen: get(ps, 'sr'),
      'device model hint': get(ps, 'uam'),
      'platform hint': get(ps, 'uap'),
      'consent flag': gcsWords(get(ps, 'gcs')),
      'consent detail (gcd)': get(ps, 'gcd'),
      'measurement ID': get(ps, 'tid'),
    }),
  },
  {
    name: 'Google Analytics (Universal)',
    test: (h, p) => /(^|\.)google-analytics\.com$/.test(h) && /\/(r\/)?collect|__utm/.test(p),
    fields: (ps) => ({event: get(ps, 't'), 'page address': get(ps, 'dl'), 'page title': get(ps, 'dt'), 'browser ID (cid)': get(ps, 'cid'), screen: get(ps, 'sr'), language: get(ps, 'ul')}),
  },
  {
    name: 'Google Ads / DoubleClick',
    test: (h) => /(^|\.)(doubleclick\.net|googleadservices\.com|googlesyndication\.com|google\.com|google\.[a-z.]+)$/.test(h),
    match: (h, p) => /pagead|viewthroughconversion|conversion|ccm\/collect|1p-user-list|\/ddm\/|activity|\/td\/|gampad|\/ads/.test(p) || /doubleclick|googleadservices|googlesyndication/.test(h),
    fields: (ps) => ({
      'page address': get(ps, 'url', 'u_url', 'dl', 'top', 'frm'),
      'came from (referrer)': get(ps, 'ref', 'dr'),
      'ad click ID (gclid)': get(ps, 'gclid'),
      'account / tag ID': get(ps, 'id', 'tid', 'conversion_id'),
      'consent flag': gcsWords(get(ps, 'gcs')),
      'ad network ID': get(ps, 'guid', 'auid', 'cookie', 'ga_vid'),
      screen: get(ps, 'u_w') && `${get(ps, 'u_w')}x${get(ps, 'u_h')}`,
      language: get(ps, 'hl', 'u_lang'),
    }),
  },
  {
    name: 'Meta Pixel',
    test: (h, p) => /(^|\.)facebook\.(com|net)$/.test(h) && /^\/tr\/?/.test(p),
    fields: (ps) => {
      const f = {
        'pixel ID': get(ps, 'id'),
        event: get(ps, 'ev'),
        'page address': get(ps, 'dl'),
        'came from (referrer)': get(ps, 'rl'),
        'Facebook browser ID (fbp)': get(ps, 'fbp'),
        'Facebook click ID (fbc)': get(ps, 'fbc'),
        screen: get(ps, 'sw') && `${get(ps, 'sw')}x${get(ps, 'sh')}`,
      };
      for (const [k, v] of ps) {
        const m = /^ud\[(\w+)\]$/.exec(k);
        if (m) f[`hashed personal data (${{em: 'email', ph: 'phone', fn: 'first name', ln: 'last name', ct: 'city', zp: 'zip', external_id: 'customer ID', ge: 'gender', db: 'birth date', st: 'state', country: 'country'}[m[1]] || m[1]})`] = v;
        const c = /^cd\[(.+)\]$/.exec(k);
        if (c) f[`event data: ${c[1]}`] = v;
      }
      return f;
    },
  },
  {
    name: 'TikTok Pixel',
    test: (h) => /(^|\.)tiktok(w)?\.(com|us)$|analytics\.tiktok/.test(h),
    fields: (ps) => ({
      event: get(ps, 'event'),
      'pixel ID': get(ps, 'context.pixel.code', 'sdkid', 'pixel_code'),
      'page address': get(ps, 'context.page.url', 'url'),
      'came from (referrer)': get(ps, 'context.page.referrer'),
      'TikTok browser ID (ttp)': get(ps, 'context.user.anonymous_id', 'context.ad.ttp', '_ttp'),
      'hashed email': get(ps, 'context.user.email', 'properties.email'),
      'hashed phone': get(ps, 'context.user.phone_number', 'context.user.phone'),
    }),
  },
  {
    name: 'LinkedIn Insight',
    test: (h) => /(^|\.)(ads\.linkedin\.com|linkedin\.com|licdn\.com)$/.test(h),
    match: (h, p) => /collect|attribution|li\/track|insight/.test(h + p),
    fields: (ps) => ({'partner ID': get(ps, 'pid'), 'page address': get(ps, 'url'), 'conversion ID': get(ps, 'conversionId'), 'LinkedIn browser ID': get(ps, 'liSync', 'li_fat_id')}),
  },
  {
    name: 'X (Twitter) Pixel',
    test: (h) => /(^|\.)(t\.co|ads-twitter\.com|analytics\.twitter\.com|twitter\.com|x\.com)$/.test(h),
    match: (h, p) => /adsct|i\/adsct|1\/i\/adsct|jot|uwt/.test(p) || /analytics\.twitter|ads-twitter/.test(h),
    fields: (ps) => ({'pixel ID': get(ps, 'p_id', 'txn_id'), 'page address': get(ps, 'tw_document_href'), event: get(ps, 'events', 'event'), 'X browser ID': get(ps, 'twclid', 'tw_iframe_status')}),
  },
  {
    name: 'Pinterest Tag',
    test: (h) => /(^|\.)(ct\.pinterest\.com|pinterest\.com|pinimg\.com)$/.test(h),
    match: (h, p) => /\/v3|\/user\/|\/ct\./.test(p) || /^ct\./.test(h),
    fields: (ps) => ({'tag ID': get(ps, 'tid'), event: get(ps, 'event'), 'page address': get(ps, 'pd.url', 'ad.loc'), 'hashed email': get(ps, 'pd.em', 'em')}),
  },
  {
    name: 'Snap Pixel',
    test: (h) => /(^|\.)(tr\.snapchat\.com|sc-static\.net|snapchat\.com)$/.test(h),
    fields: (ps) => ({'pixel ID': get(ps, 'pid'), event: get(ps, 'ev'), 'page address': get(ps, 'pl', 'u'), 'hashed email': get(ps, 'u_hem'), 'hashed phone': get(ps, 'u_hpn'), 'Snap browser ID': get(ps, 'u_scsid', 'u_sclid')}),
  },
  {
    name: 'Reddit Pixel',
    test: (h) => /(^|\.)(alb\.reddit\.com|reddit\.com|redditstatic\.com)$/.test(h),
    match: (h, p) => /rp\.gif|pixel|\/rp/.test(p),
    fields: (ps) => ({'pixel ID': get(ps, 'id'), event: get(ps, 'event'), 'page address': get(ps, 'url'), 'hashed email': get(ps, 'em', 'm.em'), 'Reddit browser ID': get(ps, 'uuid')}),
  },
  {
    name: 'Microsoft Ads (UET)',
    test: (h) => /(^|\.)bat\.bing\.com$|(^|\.)bat\.bing\.net$/.test(h),
    fields: (ps) => ({'tag ID': get(ps, 'ti'), event: get(ps, 'evt', 'ea'), 'page address': get(ps, 'p'), 'page title': get(ps, 'tl'), 'came from (referrer)': get(ps, 'r'), 'Microsoft browser ID (mid)': get(ps, 'mid'), 'visitor ID (vid)': get(ps, 'vid'), 'session ID (sid)': get(ps, 'sid')}),
  },
  {
    name: 'Microsoft Clarity',
    test: (h) => /(^|\.)clarity\.ms$/.test(h),
    fields: () => ({'what it is': 'session recording: clicks, scrolls and page changes (body is compressed)'}),
  },
  {
    name: 'Hotjar',
    test: (h) => /(^|\.)(hotjar\.com|hotjar\.io)$/.test(h),
    fields: () => ({'what it is': 'session recording and heatmaps'}),
  },
  {
    name: 'Yandex Metrica',
    test: (h, p) => /(^|\.)mc\.yandex\.(ru|com)$/.test(h),
    fields: (ps) => ({'counter ID': undefined, 'page address': get(ps, 'page-url'), 'came from (referrer)': get(ps, 'page-ref'), 'browser info': get(ps, 'browser-info')}),
  },
  {
    name: 'Criteo',
    test: (h) => /(^|\.)criteo\.(com|net)$/.test(h),
    fields: (ps) => ({'account ID': get(ps, 'a'), 'page address': get(ps, 'tld', 'u', 'dl'), event: get(ps, 'p0', 'p1'), 'Criteo browser ID': get(ps, 'gum', 'bundle', 'cto_bundle'), 'hashed email': get(ps, 'h', 'em')}),
  },
  {
    name: 'Taboola',
    test: (h) => /(^|\.)(taboola\.com|taboolasyndication\.com)$/.test(h),
    fields: (ps) => ({'page address': get(ps, 'item-url', 'url', 'ref'), 'Taboola user ID': get(ps, 'ui', 'user.id', 'vi'), event: get(ps, 'name', 'en')}),
  },
  {
    name: 'Outbrain',
    test: (h) => /(^|\.)(outbrain\.com|outbrainimg\.com)$/.test(h),
    fields: (ps) => ({'page address': get(ps, 'url', 'contentUrl'), 'Outbrain user ID': get(ps, 'obuid', 'idx'), event: get(ps, 'name')}),
  },
  {
    name: 'Amazon Ads',
    test: (h) => /(^|\.)amazon-adsystem\.com$/.test(h),
    fields: (ps) => ({'page address': get(ps, 'url', 'pu', 'u'), 'Amazon ad ID': get(ps, 'ex-fargs', 'amzn_id', 'aid')}),
  },
  {
    name: 'The Trade Desk',
    test: (h) => /(^|\.)adsrvr\.org$/.test(h),
    fields: (ps) => ({'advertiser ID': get(ps, 'adv'), 'page address': get(ps, 'upv', 'ref', 'url'), 'Trade Desk user ID (tdid)': get(ps, 'tdid', 'ttd_puid', 'td1')}),
  },
];

export function decode(r, host, pathName) {
  for (const d of D) {
    if (d.test(host, pathName) && (!d.match || d.match(host, pathName))) {
      const ps = params(r);
      const raw = d.fields(ps);
      const fields = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      return {decoder: d.name, fields};
    }
  }
  return null;
}
