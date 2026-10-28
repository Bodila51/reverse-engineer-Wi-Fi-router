---
name: site-xray
description: Open a public website as different visitors (a German laptop, an American laptop, a British phone, or just you) and show what the site collects about each of them and which companies receive it - before any click, after "Reject all", the search word, a typed email that was never submitted, IDs shared between ad companies, session recording and device fingerprinting. A team of agents does it - Haiku scouts visit, Sonnet analyses, Opus checks every claim - with a cost table at the end. Use when someone asks what a website collects, who it shares data with, whether "Reject all" works, or wants a privacy check of a site.
---

# Site X-ray

You run a small team. Scouts visit the site, an analyst explains what was recorded, an auditor checks every claim against the raw requests. Then you open the report.

All commands: `node <this folder>/scripts/xray.mjs <command>` (call it `xray` below). Run `npm install` in this folder once if `xray doctor` says deps are missing.

## Rules

- Public pages only. Never log in, never submit a form, never press Enter in a field, never buy or book anything. At most 5 page views per visit. One visit at a time per identity.
- Report only what was recorded. Mark anything inferred as inferred. Never call something illegal; say what happened and when. Never say where a server is located; say which company received the data.
- If a site blocks a visit, record "blocked" and move on. Don't retry with tricks.
- Never print or save the Gologin token, a connect URL or a Live View URL. The token lives in the environment (`GOLOGIN_TOKEN`) or the system password store; `xray` reads it itself.

## 1. Plan

1. `xray doctor`. With a Gologin token you can visit as several people from different countries. Without one, only `local` (your own Chrome) works: say so and continue with it.
2. Pick the people from `identities.json`:
   - full team: `eu-reject`, `eu-reject-2` (repeat, so every claim is checked twice), `eu-accept`, `us`, `uk-phone`
   - free Gologin plan (1 session at a time): `eu-reject`, `us`, `uk-phone`, one after another
   - no token: `local`
3. Run folder: `~/site-xray-runs/<site>-<YYYYMMDD-HHMM>`. Create `agents.json` there: `{"agents": []}`.

## 2. Scouts (Haiku)

Start one agent per identity with the Agent tool and `model: "haiku"`. In parallel only if the plan allows that many sessions; otherwise one after another. After each Agent call, add `{"agentId": "<id from the result>", "role": "scout", "identity": "<identity>", "job": "visits as <label>"}` to agents.json.

Scout brief (fill in URL, identity, run folder, consent choice and a search word):

> You visit one public website as one person and record everything. Use only these commands:
> `node <folder>/scripts/xray.mjs start <URL> --as <identity> --run <run>` (add `--watch` if the user wants to watch the browser live, `--record` if they want a video of it), then `look`, `click <i> --phase <name>`, `type <i> <text> --phase <name>`, `goto <link index> --phase <name>`, `scroll --phase <name>`, `stop`, each with `--as <identity> --run <run>`.
> 1. `start`, then `look`. If there is a cookie banner (elements marked inBanner), click the button that means **<Reject all / Accept all>** in whatever language, with `--phase after-reject` or `--phase after-accept`. If "Reject" is only behind "Settings" or "Preferences", open that and reject everything except what is strictly necessary, then save. If the only way to reject is to pay ("Reject and subscribe"), don't pay: note "pay or accept" and click nothing. If there is no banner, say so.
> 2. If there is a search box (isSearch), type the word **<word>** into it. Never press Enter.
> 3. If there is a newsletter or email field (isEmail), type `xray-<runId>@example.com` (runId is in <run>/run.json). Don't submit. 
> 4. Open 1-2 internal pages a normal visitor would open (an article, a product or a category) with `goto <link index>`, then `scroll`.
> 5. `stop`. Reply with 5 lines of JSON: identity, banner (found, what you clicked), search done, email typed, blocked, problems.
> Never log in, never submit, never type anything else.

Choose a search word that fits the site but does not appear on its home page (a shop: "corduroy jacket"; news: "tide tables"; travel: "lighthouse"). Use the same word for every person.

## 3. Analysis

1. `xray analyze --run <run>` writes `findings.json` and `evidence.jsonl` (every finding points to request ids like `eu-reject:r184`).
2. Analyst: Agent tool, `model: "sonnet"`, added to agents.json as `role: "analyst"`. Brief:

> Read <run>/findings.json and only the evidence lines you need from <run>/evidence.jsonl. Write <run>/analysis.json: for each company, what it received in plain words (page address, search word, an ID that follows you, a hashed email...); the differences between the people (who got which companies, banner or no banner, Reject respected or not); and up to 5 headline candidates, each one sentence with its evidence ids. Plain words, no legal judgements, no server locations.

3. Auditor: Agent tool, `model: "opus"`, `role: "auditor"`. Brief:

> Check <run>/analysis.json against the raw requests in <run>/evidence.jsonl and <run>/*/capture.json. For each headline: open its evidence and confirm the request really shows it. A claim must appear in both EU reject runs (eu-reject and eu-reject-2) to be "confirmed"; if only one run has it, mark it "seen once"; if the evidence doesn't show it, "dropped". Keep cookieless pings apart from requests with cookies or IDs. Wording: never "illegal", no claims about all websites, never a server location; say which company received what, and when (before any click, after Reject). For every company in the final table, verify its headquarters country on the company's own website and give the URL; unknown stays unknown. Write <run>/final.json:
> `{"headlines":[{"text","status":"confirmed|seen once|dropped","evidence":[...]}], "companies":[same objects as findings.companies, with "hq" and "hqSource" checked], "protect":[5 short steps a reader can do today], "ownerFix":[what the site owner should change]}`

## 4. Report

1. `xray cost --run <run>`: tokens per agent from Claude Code's own transcripts (model id read from the transcript), browser minutes and MB per Gologin session. Prices: `prices.json` (API list prices; fill in your Gologin plan's rates there to see browser dollars).
2. `xray report --run <run>`: writes and opens `report.html`.
3. `xray cleanup` if any visit crashed: deletes leftover temporary Gologin profiles.

Tell the user in a few lines: the confirmed headlines, how each person was treated differently, the 5 protection steps, and the total time and cost.
