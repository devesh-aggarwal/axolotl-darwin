#!/bin/sh
# Switch Codex (and ChatGPT Work) between the two demo setups. Restart the ChatGPT app afterwards.
#   base     Uber Eats plugin only: Axolotl off (server and Stop hook) and Codex's browser/computer-use plugins off,
#            so Codex can't route around the plugin on its own. This is what the original ChatGPT session had.
#   axolotl  Axolotl on, browser/computer-use plugins on (Axolotl's plan builds the cart through the browser).
#   status   Show the current setup.
set -eu
mode="${1:-status}"
CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"

python3 - "$mode" "$CONFIG" <<'PY'
import re, shutil, sys
mode, path = sys.argv[1], sys.argv[2]
BROWSER = ["browser@openai-bundled", "chrome@openai-bundled", "computer-use@openai-bundled", "unified-computer-use@openai-bundled"]
text = open(path).read()

def header(name):
    return f'[plugins."{name}"]' if "@" in name else f"[mcp_servers.{name}]"

def get(name):
    m = re.search(re.escape(header(name)) + r"\s*\n((?:(?!\[).*\n?)*)", text)
    if not m:
        return None
    e = re.search(r"^\s*enabled\s*=\s*(true|false)", m.group(1), re.M)
    return e is None or e.group(1) == "true"

def set_(name, on):
    global text
    m = re.search(re.escape(header(name)) + r"\s*\n((?:(?!\[).*\n?)*)", text)
    if not m:
        return
    body = m.group(1)
    line = f"enabled = {'true' if on else 'false'}\n"
    if re.search(r"^\s*enabled\s*=", body, re.M):
        body = re.sub(r"^\s*enabled\s*=.*\n?", line, body, count=1, flags=re.M)
    else:
        body = line + body
    text = text[: m.start(1)] + body + text[m.end(1):]

if mode in ("base", "axolotl"):
    on = mode == "axolotl"
    shutil.copy(path, path + ".bak-demo-mode")
    set_("axolotl", on)
    for b in BROWSER:
        set_(b, on)
    open(path, "w").write(text)
elif mode != "status":
    sys.exit("usage: codex-demo-mode.sh base|axolotl|status")

print(f"axolotl server + hook: {'on' if get('axolotl') else 'off'}")
for b in BROWSER:
    state = get(b)
    print(f"{b}: {'not installed' if state is None else 'on' if state else 'off'}")
if mode in ("base", "axolotl"):
    print("Restart the ChatGPT app, then start a new chat.")
PY
