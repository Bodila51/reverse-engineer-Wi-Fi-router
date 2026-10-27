# Reverse-engineer your Wi-Fi router

Send Claude Code one photo of your router. It works out the router's hidden admin API by itself and does two things:

1. **Privacy check**: what your router knows about you and what your internet provider can see and reach
2. **Fix slow Wi-Fi**: finds why it's slow, fixes it after your yes, and lets you control the router from the chat

No router manual, no tutorials. Your own network only, no exploits, no password guessing.

## New: Site X-ray

A team of agents (Haiku, Sonnet, Opus) opens a public website as three different visitors: a German laptop, an American laptop and a British phone, and shows what the site collects about each of them and which companies receive it. Details: [site-xray/README.md](site-xray/README.md)

```bash
git clone https://github.com/Bodila51/reverse-engineer-Wi-Fi-router /tmp/re && cp -R /tmp/re/site-xray ~/.claude/skills/site-xray && cd ~/.claude/skills/site-xray && npm install
```

## What it found on my router

- my router keeps a list of 29 devices that ever touched my Wi-Fi
- my internet connection is literally named `TR069_INTERNET`. that's my provider's remote management channel, and I can't turn it off
- there's no update button. my router runs June 2025 software and only my provider can change it
- every site I opened was looked up through my provider in plain text
- my provider's app on my TV box kept sending data while the TV was off
- my router logs every login and every setting I change, to the minute

## Install

As a Claude Code skill:

```bash
git clone https://github.com/Bodila51/reverse-engineer-Wi-Fi-router ~/.claude/skills/reverse-engineer-wifi-router
```

Then open Claude Code on a computer connected to your home Wi-Fi, attach a photo of your router (cover the password sticker) and ask:

- "what does my router know about me?"
- or "my Wi-Fi is slow, fix it"

Don't want to install anything? Paste one of the prompts into Claude Code instead:

- [prompts/privacy-check.md](prompts/privacy-check.md)
- [prompts/fix-slow-wifi.md](prompts/fix-slow-wifi.md)

Your admin password goes into your system's password store with one command Claude gives you. It never goes into the chat.

Works on most routers with a web admin page. App-only routers (eero, Google Nest) get a shorter check.

## How to fix your privacy

1. Change the admin password from the one on the sticker
2. Turn on encrypted DNS: Private DNS on Android, secure DNS in Chrome or Firefox, DNS encryption on Windows 11, the free [1.1.1.1 app](https://one.one.one.one) on iPhone and Mac. Your provider stops seeing your lookups
3. Turn on Private Wi-Fi Address on your phone. It stops showing its real ID to every router
4. Add `_nomap` to the end of your Wi-Fi name. [Apple](https://support.apple.com/en-us/102515) and [Google](https://support.google.com/maps/answer/1725632) stop adding it to their location maps
5. Change your Wi-Fi password if your router remembers devices you don't recognize

Encrypted DNS hides your lookups, not which servers you connect to. Only a VPN hides that.

## It's not just my router

- Nearly 1 billion home devices have the TR-069 remote management channel. Hils & Böhme, University of Innsbruck, "Watching the Weak Link into Your Home", ACNS 2020, [arXiv:2001.02564](https://arxiv.org/abs/2001.02564)
- Researchers pulled the locations of more than 2 billion routers from Apple's Wi-Fi database, precise enough to find individual homes. Rye & Levin, University of Maryland, "Surveilling the Masses with Wi-Fi-Based Positioning Systems", 2024, [arXiv:2405.14975](https://arxiv.org/abs/2405.14975)

## What's inside

- `SKILL.md`: the instructions Claude follows for both jobs
- `prompts/`: the same two jobs as copy-paste prompts
- `scripts/dns-check.sh`: shows which company answers your DNS lookups. Run it before and after the fix
- `scripts/mask.py`: masks public IPs, MAC addresses, serial numbers and your Wi-Fi name in any output, so you can screenshot it safely

## License

MIT
