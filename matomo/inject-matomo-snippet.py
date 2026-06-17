#!/usr/bin/env python3
"""
Inject a Matomo tracking snippet into a domain's Apache SSL vhost via
mod_substitute. Generalized version of inject-matomo-canary.py.

Usage:
    python3 inject-matomo-snippet.py <domain> <matomo_site_id>

Idempotent — re-running strips any existing # matomo-canary block for
the same domain before adding the new one, so changing the siteId is
just `python3 inject-matomo-snippet.py example.com 7` + `systemctl
reload apache2`.

Revert:
    Delete the four lines between the `# matomo-canary` marker comment
    and the `Substitute` directive in the *-le-ssl.conf file and reload
    Apache.

The snippet uses single-quoted JS string literals so Apache's tokenizer
sees the whole pattern as one argument (avoids the embedded-quote bug
that would otherwise break Substitute parsing).
"""
import sys, os, re

if len(sys.argv) != 3:
    print(__doc__, file=sys.stderr)
    sys.exit(2)

domain  = sys.argv[1].strip()
site_id = sys.argv[2].strip()

if not re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", domain):
    sys.exit(f"Invalid domain: {domain}")
if not site_id.isdigit():
    sys.exit(f"site_id must be an integer: {site_id}")

vhost = f"/etc/apache2/sites-available/{domain}-le-ssl.conf"
if not os.path.exists(vhost):
    sys.exit(f"SSL vhost not found: {vhost}")

with open(vhost) as f:
    lines = f.read().split("\n")

# Strip any prior matomo-canary block: the four lines starting at the
# `# matomo-canary` marker (2 comment lines + AOFBT + Substitute).
keep, skip_until = [], None
for ln in lines:
    if skip_until is not None:
        # consume the four-line block; matching is positional by directive prefix
        if skip_until == "expect-second-comment":
            skip_until = "expect-aofbt" if ln.strip().startswith("# every HTML response") else None
            if skip_until is None: keep.append(ln)
            continue
        if skip_until == "expect-aofbt":
            skip_until = "expect-substitute" if ln.strip().startswith("AddOutputFilterByType SUBSTITUTE") else None
            if skip_until is None: keep.append(ln)
            continue
        if skip_until == "expect-substitute":
            if ln.strip().startswith("Substitute "):
                skip_until = None
            else:
                keep.append(ln)
                skip_until = None
            continue
    if "# matomo-canary" in ln:
        skip_until = "expect-second-comment"
        continue
    keep.append(ln)
txt = "\n".join(keep)

snippet = (
    "<script>var _paq=window._paq=window._paq||[];"
    "_paq.push(['disableCookies']);"
    "_paq.push(['setDoNotTrack',true]);"
    "_paq.push(['trackPageView']);"
    "_paq.push(['enableLinkTracking']);"
    "(function(){var u='https://analytics.danhorntx.com/';"
    "_paq.push(['setTrackerUrl',u+'cdn/event.php']);"
    f"_paq.push(['setSiteId','{site_id}']);"
    "var d=document,g=d.createElement('script'),s=d.getElementsByTagName('script')[0];"
    "g.async=true;g.src=u+'cdn/script.js';"
    "s.parentNode.insertBefore(g,s);})();</script>"
)
block = (
    "\n    # matomo-canary — Matomo analytics snippet injected into\n"
    "    # every HTML response. Remove this block to revert.\n"
    "    AddOutputFilterByType SUBSTITUTE text/html\n"
    f'    Substitute "s~</head>~{snippet}</head>~ni"\n'
)
txt = txt.replace("</VirtualHost>", block + "</VirtualHost>", 1)
with open(vhost, "w") as f:
    f.write(txt)
print(f"OK — injected siteId={site_id} into {vhost}")
