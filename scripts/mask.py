#!/usr/bin/env python3
"""Mask private details in any command output before it goes on screen.

Usage: some-command | python3 scripts/mask.py

Masks: public IPv4 (keeps the first two parts), IPv6, the second half of
MAC addresses, and values on lines that mention a serial number or SSID.
Keeps home-network addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x),
well-known public resolvers and carrier-grade NAT prefixes readable.
"""
import ipaddress
import re
import sys

KEEP = {"1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "127.0.0.1"}
CGNAT = ipaddress.ip_network("100.64.0.0/10")

IPV4 = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
MAC = re.compile(r"\b([0-9A-Fa-f]{2})([:-])([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})\2[0-9A-Fa-f]{2}\2[0-9A-Fa-f]{2}\2[0-9A-Fa-f]{2}\b")
IPV6_CANDIDATE = re.compile(r"(?<![0-9A-Za-z:*])[0-9A-Fa-f]*:[0-9A-Fa-f:]*:[0-9A-Fa-f.]*(?:%\w+)?(?![0-9A-Za-z:*])")
SECRET_LINE = re.compile(r"(serial|ssid|bssid|passphrase|password)(\w*)(\s*[:=]\s*)([^\s;,]+)", re.I)


def mask_ipv4(m):
    text = m.group(0)
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return text
    if text in KEEP or ip.is_private or ip.is_loopback or ip.is_link_local:
        return text
    if ip in CGNAT or ip.is_global:
        return f"{m.group(1)}.{m.group(2)}.x.x"
    return text


def mask_ipv6(m):
    text = m.group(0)
    try:
        ip = ipaddress.ip_address(text.split("%")[0])
    except ValueError:
        return text
    if ip.version != 6 or ip.is_loopback:
        return text
    return "xxxx:xxxx::xxxx"


def mask_line(line):
    line = SECRET_LINE.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}****", line)
    line = MAC.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}{m.group(2)}{m.group(4)}{m.group(2)}**{m.group(2)}**{m.group(2)}**", line)
    line = IPV6_CANDIDATE.sub(mask_ipv6, line)
    line = IPV4.sub(mask_ipv4, line)
    return line


if __name__ == "__main__":
    for raw in sys.stdin:
        sys.stdout.write(mask_line(raw))
        sys.stdout.flush()
