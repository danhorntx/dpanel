#!/usr/bin/env python3
"""Inject the mod_substitute matomo block into the danhorntx.com SSL vhost.

The snippet uses single-quoted JS string literals so the only " character
in the whole directive is the outermost Apache quote. Apache's parser sees
it as one argument cleanly.
"""
import sys

path = "/etc/apache2/sites-available/danhorntx.com-le-ssl.conf"
with open(path) as f:
    txt = f.read()

# Strip any prior matomo-canary block (re-runnable)
if "# matomo-canary" in txt:
    # remove from marker to end of directive line
    lines = txt.split("\n")
    keep = []
    skip = False
    for ln in lines:
        if "# matomo-canary" in ln:
            skip = True
            continue
        if skip:
            # the substitute block is 4 consecutive lines (comment, comment, AOFBT, Substitute)
            if ln.strip().startswith("# every HTML response"):
                continue
            if ln.strip().startswith("AddOutputFilterByType SUBSTITUTE"):
                continue
            if ln.strip().startswith("Substitute "):
                skip = False
                continue
            skip = False
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
    "_paq.push(['setSiteId','3']);"
    "var d=document,g=d.createElement('script'),s=d.getElementsByTagName('script')[0];"
    "g.async=true;g.src=u+'cdn/script.js';"
    "s.parentNode.insertBefore(g,s);})();</script>"
)
block = (
    "\n    # matomo-canary — Phase 7. Injects the tracking snippet into\n"
    "    # every HTML response. Remove this whole block to revert.\n"
    "    AddOutputFilterByType SUBSTITUTE text/html\n"
    '    Substitute "s~</head>~' + snippet + '</head>~ni"\n'
)
new_txt = txt.replace("</VirtualHost>", block + "</VirtualHost>", 1)
with open(path, "w") as f:
    f.write(new_txt)
print("OK — block rewritten")
