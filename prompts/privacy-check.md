# What does my router know about me?

Paste it into Claude Code with a photo of your router:

```
I want to see what my own home router knows about me and what my internet provider can see. I've attached a photo of my router with the password sticker covered.

1. From the photo, identify the router model and find its admin page on my network. If it's app-only with no web page, tell me what the app can show instead.
2. Log in with my admin password. Ask me to type it into a hidden Terminal prompt or the system keychain, never into this chat. Never guess passwords.
3. These panels usually have no public API. Reverse-engineer how the panel itself loads its data (its login and internal requests) and read everything it shows me. If a page is missing, look for the same data elsewhere in the panel.
4. Show me:
   - every device the router remembers, and which are online now
   - the internet connection names and any sign of remote management by my provider (TR-069, CWMP, ACS)
   - whether I can update the firmware myself or only my provider can
   - which DNS servers my devices use and who owns them (whois)
   - ports opened automatically by my devices (UPnP)
   - which logs the router keeps and whether they have timestamps
5. From this computer, show my DNS servers and the first hops of a traceroute, so I can see which traffic goes through my provider.

Rules: read-only. Change no router setting and don't reboot. If viewing something needs a setting switched, ask me first and switch it back afterwards. No exploits, no scanning anything outside my home network, never print passwords or tokens. Mask MAC addresses and my public IP in everything you show.

Done means a short report with three headings: What my router knows, What my provider can see, How to fix it. In the fix part, give the official steps to turn on encrypted DNS on each of my devices, how to add _nomap to my Wi-Fi name, and anything else on the router worth changing. Ask before changing anything.
```
