---
name: reverse-engineer-wifi-router
description: Reverse-engineer your own home Wi-Fi router from one photo. Two jobs - a read-only privacy check (every device it remembers, what your internet provider can see and reach through TR-069 and DNS, firmware age, logs, how to fix it) and a slow Wi-Fi fix (backup, speed test, fixes only after your yes, chat control). Use when someone asks what their router knows about them, about router privacy or ISP remote access, or says their Wi-Fi is slow.
---

# Reverse-engineer your Wi-Fi router

Work only on the user's own router and home network. Start from the photo they attach.

Pick the job from what they ask:
- "what does my router know", privacy, provider, TR-069: **Job 1, privacy check** (read-only)
- slow Wi-Fi, lag, drops, "control my router": **Job 2, fix slow Wi-Fi**
- not sure: ask which one, or do Job 1 first

## Rules for both jobs

- If the photo shows a password, never repeat or save it.
- Password: give the user one terminal command that saves the admin password to the system password store (macOS Keychain, Windows Credential Manager, Linux secret-tool) and read it from there. Never ask for it in chat, never print passwords, tokens or cookies. If login fails once, stop and ask.
- Never guess or brute-force passwords, never use exploits, no telnet/ssh attempts, no port scans. Nothing outside the home network except DNS, whois, traceroute and speed tests.
- Never change the Wi-Fi name or passwords, reboot without asking, update firmware or reset.
- Pipe anything you show through `scripts/mask.py` so public IPs, the second half of MAC addresses, serial numbers and the Wi-Fi name are masked.
- Report only what you observed. Mark anything inferred as inferred.

## Getting in (both jobs)

1. From the photo: brand, model, and whether it's an ISP-branded box. Find the gateway address (`route -n get default` on macOS, `ip route` on Linux, `ipconfig` on Windows). If the router is app-only (eero, Google Nest, some Deco), say what the app can show and do what you can from the computer.
2. Don't stop at the first wall. Try an official API, an open-source library or Home Assistant integration for this model, or the admin page's own JavaScript API. Home router panels almost never have a public API: read the login page and its JavaScript to learn the login flow (tokens, hashing, cookies), then list the pages and internal requests (ajax, cgi, json, asp) it uses to load data. If login needs a captcha or the provider's account, open a browser and let the user log in. If the provider hides settings, tell the user where to unlock them.
3. Save a short map of what you found to `~/router/api-map.md`.

## Job 1: privacy check (read-only)

Change nothing. If seeing something needs a setting switched (for example a log type dropdown), ask first, note the old value and switch it back afterwards.

Collect from the router:
- every device it remembers (online and offline), names, and how many use private (randomized) MAC addresses (locally administered bit set)
- internet (WAN) connection names and any sign of provider remote management: TR-069, CWMP, ACS, "management server" pages, connection names like `TR069_INTERNET`
- firmware version, build date, and whether the user has any update or config backup page
- DNS servers the router hands out, and who owns them (`whois`)
- UPnP on or off, and any automatic port mappings
- which logs exist, whether they have timestamps, and what kinds of events they record (summarize, never dump whole logs)

Check from this computer:
- `scripts/dns-check.sh`: which company answers this computer's DNS lookups
- `traceroute -m 4 1.1.1.1` (`tracert -h 4 1.1.1.1` on Windows): the first hop after the router is the provider's network; `100.64.0.0/10` means carrier-grade NAT

Optional, only if the user says yes: an Android TV / Google TV box on the same network with ADB debugging on. Read per-app network usage with `adb shell dumpsys netstats`, map UIDs to packages with `adb shell cmd package list packages -U`, and point out provider apps that send data while the TV is asleep. Read-only.

Report with three headings: **What my router knows**, **What my provider can see**, **How to fix it**. Keep it honest:
- A home router does not store browsing history. The provider sees the sites you look up because DNS goes through it by default.
- TR-069 means the provider *can* remotely read and change the router. Don't claim it is spying.
- Encrypted DNS hides DNS lookups from the provider, not which servers you connect to. Only a VPN hides that.

Fix steps (official sources, ask before changing anything):
- Encrypted DNS: Android Settings > Network & internet > Private DNS (https://support.google.com/android/answer/9654714); Chrome Settings > Privacy and security > Security > Use secure DNS (https://support.google.com/chrome/answer/10468685); Firefox Settings > Privacy & Security > DNS over HTTPS (https://support.mozilla.org/kb/dns-over-https); Windows 11 DNS encryption (https://learn.microsoft.com/windows-server/networking/dns/doh-client-support); iPhone and Mac have no built-in switch, use Cloudflare's free 1.1.1.1 app in DNS-only mode (https://one.one.one.one). Run `scripts/dns-check.sh` again after.
- Private Wi-Fi Address on phones (iPhone: Settings > Wi-Fi > (i); Android: Wi-Fi network > Privacy > randomized MAC).
- Add `_nomap` to the end of the Wi-Fi name so Apple (https://support.apple.com/en-us/102515) and Google (https://support.google.com/maps/answer/1725632) stop adding it to their location databases. It doesn't work for hidden networks, and neither company says it deletes existing entries. Renaming is the user's own step: never change the Wi-Fi name yourself.
- Change the admin password from the one on the sticker.
- Change the Wi-Fi password if the router remembers devices the user doesn't recognize.

## Job 2: fix slow Wi-Fi

If the user says "just diagnose", change nothing.

Done means:
- all router settings backed up in a `router` folder in the user's home folder
- a speed test before and after (including lag under load)
- each fix applied only after the user's yes
- a small tool so the user can ask in chat "who's on my Wi-Fi" or "reboot the router"
- a report: before X Mbps vs after Y Mbps, what changed, how to undo it

Check every Wi-Fi setting against the best the router allows: band, channel and neighbors on it, width, mode, power, band steering.

Wi-Fi settings only. Show the old and new value before each change. If a form resends the Wi-Fi password, keep it unchanged, and read every value back after a change.

If the router can't be changed, fix what you can on the computer and write the exact message to send the provider.

End with: **Fixed**, **How to undo**, **What I need from you**.
