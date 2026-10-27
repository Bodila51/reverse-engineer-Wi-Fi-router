# Site X-ray

Give Claude Code a website. A team of agents opens it as three different visitors: a German laptop, an American laptop and a British phone, and shows what the site collects about each of them and which companies receive it.

- **Haiku 5.5** scouts visit the site, one per person: cookie banner, a search, a page or two, like a normal visitor
- **Sonnet 5.5** reads everything they recorded and explains it in plain words
- **Opus 5.5** checks every claim against the raw requests and marks anything seen in only one run

You get one page: which companies got your data before you clicked anything, after you clicked "Reject all", whether your search word or a typed email (never submitted) left the site, which ad companies passed your ID to each other, session recording, device fingerprinting, and what the whole check cost.

Public pages only. No logins, nothing submitted, nothing bought.

## Why it needs browsers in different countries

A normal browser is one person in one country. Sites treat people differently: a visitor from Germany gets a cookie banner, a visitor from the US often doesn't, a phone can get other scripts than a laptop. Each visit here runs in its own fresh [Gologin Cloud Browser](https://gologin.com/cloud-browser/) profile, a Chromium-based browser (Gologin's Orbita) with its own device fingerprint and a residential IP in the chosen country, so the same site is opened by a German laptop, an American laptop and a British phone, at the same time on plans that allow parallel sessions. Every profile is deleted after the visit.

No Gologin account? The `local` mode uses your own Chrome and your own connection: one person, one country.

## Install

As a Claude Code skill:

```bash
git clone https://github.com/Bodila51/reverse-engineer-Wi-Fi-router /tmp/re && cp -R /tmp/re/site-xray ~/.claude/skills/site-xray && cd ~/.claude/skills/site-xray && npm install
```

Needs Node 20+ and Google Chrome.

For the different visitors, save your Gologin API token (from the API section of your Gologin dashboard) in your system password store. On a Mac, run this in Terminal first:

```bash
echo "Copy your Gologin token, come back here and press Enter"; read x; t="$(pbpaste)"; case "$t" in eyJ*) security add-generic-password -U -a "$USER" -s GOLOGIN_TOKEN -w "$t" && pbcopy < /dev/null && echo ok;; *) echo "The clipboard does not hold a Gologin token, try again";; esac
```

It waits for Enter so that copying this command doesn't overwrite the token you copy next, then checks that the clipboard holds a token, saves it and clears the clipboard. Don't type the token at a bare `-w` prompt: that prompt keeps only the first 128 characters, and Gologin tokens are longer. On Windows or Linux, set the `GOLOGIN_TOKEN` environment variable instead. The token never goes into the chat.

Then ask Claude Code:

- "x-ray <a news site you read every day>: what does it collect about me?"
- "does Reject all actually work on <a shop you use>?"
- "who does this site send my data to: <url>"

## Run by hand

```bash
node scripts/xray.mjs doctor
node scripts/xray.mjs start https://example.com/ --as local --run runs/example
node scripts/xray.mjs look --as local --run runs/example
node scripts/xray.mjs click 5 --as local --run runs/example --phase after-reject
node scripts/xray.mjs stop --as local --run runs/example
node scripts/xray.mjs analyze --run runs/example
node scripts/xray.mjs report --run runs/example
```

`look` lists what you can click (cookie banner buttons first). `type` never presses Enter. `stop` saves `capture.json` and `capture.har` (open the HAR in Chrome DevTools). `xray cleanup` deletes leftover Gologin profiles after a crash.

## What it checks

- **Before any click**: ad and analytics requests while the cookie banner is still open. Cookieless pings (for example Google consent-mode pings after a Reject) are counted separately from requests with cookies or an ID.
- **After "Reject all"**: the same, plus ad cookies still in the browser at the end
- **Search word**: whether the word you searched for reached a third party
- **Typed email**: a made-up `@example.com` address typed into a newsletter field and never submitted, looked for as text and as MD5, SHA-1 and SHA-256 (Meta, TikTok and Snap pixels hash emails with SHA-256)
- **ID sharing**: the same ID from one company's cookie showing up in a request to another company
- **Session recording**: Hotjar, Microsoft Clarity, FullStory and similar scripts, and whether they kept running after Reject
- **Fingerprinting**: canvas reads that meet the criteria from Englehardt & Narayanan, "Online Tracking: A 1-million-site Measurement and Analysis", ACM CCS 2016; the exact graphics card via WebGL; audio fingerprints. Some sites use fingerprinting for bot protection, so the report says who owns the script.
- **Per person**: banner or not, how many companies, cookies and how long they last

## How to protect yourself

1. Turn on tracker blocking: Firefox Enhanced Tracking Protection (Strict), Safari Advanced Tracking and Fingerprinting Protection, or the uBlock Origin Lite extension in Chrome
2. Click "Reject all" on cookie banners, then run this check again on the sites you use most
3. Turn on Global Privacy Control (Firefox, Brave, DuckDuckGo browser) so every site gets a "do not sell or share" signal
4. Delete a site's cookies when you leave it, or use a separate browser profile for shopping and news
5. Don't type your email into a page until you mean to send it

## Cost

The report ends with a table: each agent, its model (read from Claude Code's own transcript), minutes, tokens and API price, plus Gologin browser minutes and MB. Prices are in `prices.json` (Anthropic API list prices, checked 2026-10-27; add your Gologin plan's rates to see browser dollars). On a Claude subscription you pay your plan, not the API price.

## Data

`data/companies.json` maps tracker domains to companies and what they do. It is our own list (MIT). A headquarters country is filled in only where it was checked on the company's own website.

## License

MIT. Uses [Playwright](https://playwright.dev) (Apache-2.0) and [tldts](https://github.com/remusao/tldts) (MIT).
