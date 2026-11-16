#!/usr/bin/env python3
"""Install and manage the Codex <-> Claude Code bridge.

Everything this script creates lives in one integration directory
(default: $CODEX_HOME/integrations/claude-subscription). It edits only the
`[model_providers.claude_subscription]` section and a few root model keys of
the Codex config, and records the previous values so they can be restored.
It never reads Claude's credential store: the official `claude` CLI handles
login and token refresh inside the isolated `account/` directory.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent
CODEX_HOME = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
CONFIG = CODEX_HOME / "config.toml"
BASE = Path(os.environ.get("CLAUDE_CODEX_INTEGRATION") or CODEX_HOME / "integrations" / "claude-subscription")
SETTINGS = BASE / "settings.json"
KEY_FILE = BASE / "proxy-key"
PREVIOUS = BASE / "previous-defaults.json"
MIGRATED = BASE / "migrated-threads.json"
LOG = BASE / "service.stdout.log"
ERR_LOG = BASE / "service.stderr.log"

PROVIDER = "claude_subscription"
SERVICE = "codex-claude-bridge"
LAUNCHD_LABEL = f"dev.{SERVICE}"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
SYSTEMD_UNIT = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "systemd" / "user" / f"{SERVICE}.service"
DEFAULT_PORT = 3456

# Root keys of config.toml that `enable` may change and `disable` restores.
TRACKED = ["model", "model_reasoning_effort", "model_provider", "model_catalog_json"]
# Chats created before the bridge belong to these providers (see migrate-threads).
OLD_PROVIDERS = ("openai",)
# Variables passed to the server; everything else (API keys, gateways, ...) is dropped.
PASS_ENV = ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "TERM")


# ---------------------------------------------------------------- helpers

def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def load_settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text())
    except FileNotFoundError:
        return {}


def port() -> int:
    return int(load_settings().get("port", DEFAULT_PORT))


def find_binary(name: str, *fallbacks: Path) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for candidate in fallbacks:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def bun_path() -> str | None:
    return load_settings().get("bun") or find_binary("bun", Path.home() / ".bun" / "bin" / "bun")


def claude_path() -> str | None:
    return load_settings().get("claude") or find_binary(
        "claude", Path.home() / ".local" / "bin" / "claude", Path.home() / ".claude" / "local" / "claude")


def claude_env() -> dict:
    env = {key: os.environ[key] for key in PASS_ENV if key in os.environ}
    env["PATH"] = os.environ.get("PATH", "/usr/bin:/bin")
    env["CLAUDE_CONFIG_DIR"] = str(BASE / "account")
    return env


def claude_auth() -> dict:
    claude = claude_path()
    if not claude:
        return {}
    result = subprocess.run([claude, "--setting-sources", "", "auth", "status"], env=claude_env(), capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}


def api(path: str, timeout: float = 30) -> dict:
    request = urllib.request.Request(f"http://127.0.0.1:{port()}/{path}", headers={"x-claude-proxy-key": KEY_FILE.read_text().strip()})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        return json.load(response)


def wait_for_health(seconds: float = 30) -> dict | None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            return api("health", timeout=3)
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(0.5)
    return None


# ---------------------------------------------------------------- config.toml

def read_config() -> str:
    return CONFIG.read_text() if CONFIG.exists() else ""


def split_root(text: str) -> tuple[str, str]:
    """Root keys (before the first [table]) and the rest of the file."""
    match = re.search(r"^\s*\[", text, re.M)
    offset = match.start() if match else len(text)
    return text[:offset], text[offset:]


def root_values(text: str) -> dict[str, str]:
    """Raw TOML values of the tracked root keys."""
    root, _ = split_root(text)
    values = {}
    for key in TRACKED:
        match = re.search(r"^[ \t]*" + re.escape(key) + r"[ \t]*=[ \t]*(.+?)[ \t]*$", root, re.M)
        if match:
            values[key] = match.group(1)
    return values


def write_config(old: str, new: str) -> None:
    if read_config() != old:
        fail("the Codex config changed while it was being edited; run the command again")
    if CONFIG.exists():
        backup = BASE / "backups" / f"config-{time.strftime('%Y%m%d-%H%M%S')}.toml"
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists():
            shutil.copy2(CONFIG, backup)
            os.chmod(backup, 0o600)
    atomic_write(CONFIG, new)


def set_root(values: dict[str, str]) -> None:
    """Replace all tracked root keys with `values` (raw TOML)."""
    text = read_config()
    root, rest = split_root(text)
    for key in TRACKED:
        root = re.sub(r"^[ \t]*" + re.escape(key) + r"[ \t]*=.*(?:\n|$)", "", root, flags=re.M)
    root = root.rstrip()
    lines = "".join(f"{key} = {value}\n" for key, value in values.items())
    root = (root + "\n" if root else "") + lines
    rest = rest.lstrip("\n")
    write_config(text, root + ("\n" + rest if rest else ""))


def provider_block(key: str) -> str:
    return (
        f"[model_providers.{PROVIDER}]\n"
        'name = "ChatGPT + Claude (local bridge)"\n'
        f'base_url = "http://127.0.0.1:{port()}/chatgpt"\n'
        'wire_api = "responses"\n'
        "requires_openai_auth = true\n"
        "request_max_retries = 4\n"
        "stream_max_retries = 2\n"
        "stream_idle_timeout_ms = 960000\n"
        "supports_websockets = false\n"
        f'http_headers = {{ "x-claude-proxy-key" = {json.dumps(key)} }}\n'
    )


PROVIDER_SECTION = re.compile(r"^\[model_providers\." + PROVIDER + r"\][^\n]*\n(?:(?!\s*\[).*(?:\n|$))*", re.M)


def write_provider(key: str | None) -> None:
    """Add or replace the provider section; `None` removes it."""
    text = read_config()
    block = provider_block(key) if key else ""
    if PROVIDER_SECTION.search(text):
        new = PROVIDER_SECTION.sub(lambda _: block + ("\n" if block else ""), text, count=1)
    elif block:
        new = text.rstrip() + ("\n\n" if text.strip() else "") + block
    else:
        return
    write_config(text, re.sub(r"\n{3,}", "\n\n", new))


def save_previous_defaults() -> None:
    if PREVIOUS.exists():
        return
    values = root_values(read_config())
    if values.get("model_provider", "").strip("\"'") == PROVIDER:
        return
    atomic_write(PREVIOUS, json.dumps({"raw": values}, indent=2) + "\n")


def previous_defaults() -> dict[str, str]:
    if not PREVIOUS.exists():
        return {}
    data = json.loads(PREVIOUS.read_text())
    if "raw" in data:
        return data["raw"]
    return {key: json.dumps(value) for key, value in data.items()}  # older format: JSON values


# ---------------------------------------------------------------- service

def system() -> str:
    name = platform.system()
    if name not in ("Darwin", "Linux"):
        fail(f"background service is not supported on {name}; run `python3 scripts/manage.py serve` yourself")
    return name


def service_command() -> list[str]:
    return [sys.executable, str(Path(__file__).resolve()), "serve"]


def install_service() -> None:
    if system() == "Darwin":
        args = "".join(f"\t\t<string>{arg}</string>\n" for arg in service_command())
        plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>{LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
{args}\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>CLAUDE_CODEX_INTEGRATION</key>
\t\t<string>{BASE}</string>
\t\t<key>CODEX_HOME</key>
\t\t<string>{CODEX_HOME}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>WorkingDirectory</key>
\t<string>{SOURCE}</string>
\t<key>StandardOutPath</key>
\t<string>{LOG}</string>
\t<key>StandardErrorPath</key>
\t<string>{ERR_LOG}</string>
</dict>
</plist>
"""
        stop_service(quiet=True)
        atomic_write(PLIST, plist, 0o644)
        subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST)], check=True)
    else:
        command = " ".join(f'"{arg}"' for arg in service_command())
        unit = f"""[Unit]
Description=Codex <-> Claude Code bridge
After=network-online.target

[Service]
Environment="CLAUDE_CODEX_INTEGRATION={BASE}" "CODEX_HOME={CODEX_HOME}"
WorkingDirectory={SOURCE}
ExecStart={command}
Restart=always
RestartSec=5
StandardOutput=append:{LOG}
StandardError=append:{ERR_LOG}

[Install]
WantedBy=default.target
"""
        atomic_write(SYSTEMD_UNIT, unit, 0o644)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", f"{SERVICE}.service"], check=True)


def start_service() -> None:
    if system() == "Darwin":
        subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST)], check=True)
    else:
        subprocess.run(["systemctl", "--user", "start", f"{SERVICE}.service"], check=True)


def stop_service(quiet: bool = False) -> None:
    if system() == "Darwin":
        result = subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], capture_output=True, text=True)
    else:
        result = subprocess.run(["systemctl", "--user", "stop", f"{SERVICE}.service"], capture_output=True, text=True)
    if result.returncode and not quiet:
        print(result.stderr.strip() or "service was not running")


def restart_service() -> None:
    if system() == "Darwin":
        subprocess.run(["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], check=True)
    else:
        subprocess.run(["systemctl", "--user", "restart", f"{SERVICE}.service"], check=True)


def remove_service() -> None:
    stop_service(quiet=True)
    if system() == "Darwin":
        PLIST.unlink(missing_ok=True)
    else:
        subprocess.run(["systemctl", "--user", "disable", f"{SERVICE}.service"], capture_output=True)
        SYSTEMD_UNIT.unlink(missing_ok=True)
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)


# ---------------------------------------------------------------- threads

def state_db() -> Path:
    def generation(path: Path) -> int:
        match = re.search(r"_(\d+)\.sqlite$", path.name)
        return int(match.group(1)) if match else -1
    dbs = sorted(CODEX_HOME.glob("state_*.sqlite"), key=generation)
    if not dbs:
        fail(f"no Codex thread database found in {CODEX_HOME}")
    return dbs[-1]


def backup_db(connection: sqlite3.Connection, db: Path) -> Path:
    target = BASE / "backups" / f"{db.stem}-{time.strftime('%Y%m%d-%H%M%S')}.sqlite"
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(target) as copy:
        connection.backup(copy)
    os.chmod(target, 0o600)
    return target


def migrate_threads() -> None:
    """Codex binds every chat to the provider it was created with and refuses
    to resume it with another one. The bridge relays GPT requests unchanged,
    so moving older `openai` chats to it is safe and lets them use Claude too.
    Only the database row changes; rollout files are never touched."""
    db = state_db()
    connection = sqlite3.connect(db, timeout=30)
    try:
        backup = backup_db(connection, db)
        marks = ",".join("?" * len(OLD_PROVIDERS))
        rows = connection.execute(f"select id, model_provider from threads where model_provider in ({marks})", OLD_PROVIDERS).fetchall()
        record = json.loads(MIGRATED.read_text()) if MIGRATED.exists() else {}
        for thread, provider in rows:
            record.setdefault(thread, provider)
        atomic_write(MIGRATED, json.dumps(record, indent=1) + "\n")
        with connection:
            connection.execute(f"update threads set model_provider = ? where model_provider in ({marks})", (PROVIDER, *OLD_PROVIDERS))
    finally:
        connection.close()
    print(f"{len(rows)} chats now use the bridge (backup: {backup}). Restart Codex so open chats reload.")


def restore_threads(everything: bool = False) -> None:
    """Undo migrate-threads. With `everything`, also move chats created
    through the bridge to `openai`, so they still open without it."""
    record = json.loads(MIGRATED.read_text()) if MIGRATED.exists() else {}
    if not record and not everything:
        print("Nothing to restore.")
        return
    db = state_db()
    connection = sqlite3.connect(db, timeout=30)
    try:
        backup_db(connection, db)
        with connection:
            for thread, provider in record.items():
                connection.execute("update threads set model_provider = ? where id = ? and model_provider = ?", (provider, thread, PROVIDER))
            moved = connection.execute("update threads set model_provider = 'openai' where model_provider = ?", (PROVIDER,)).rowcount if everything else 0
    finally:
        connection.close()
    MIGRATED.unlink(missing_ok=True)
    print(f"{len(record) + moved} chats restored. Restart Codex.")


# ---------------------------------------------------------------- commands

def serve(_: argparse.Namespace) -> None:
    """Run the server in the foreground (used by the background service)."""
    settings = load_settings()
    bun, claude = bun_path(), claude_path()
    if not bun:
        fail("bun not found; install it from https://bun.sh")
    if not claude:
        fail("claude not found; install Claude Code from https://claude.com/claude-code")
    if not KEY_FILE.exists():
        fail(f"{KEY_FILE} is missing; run `python3 scripts/manage.py install` first")
    for folder in ("account", "runtime"):
        (BASE / folder).mkdir(mode=0o700, parents=True, exist_ok=True)
    env = {key: os.environ[key] for key in PASS_ENV if key in os.environ}
    env.setdefault("HOME", str(Path.home()))
    folders = [str(Path(claude).parent), str(Path(bun).parent), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    env["PATH"] = ":".join(dict.fromkeys(folders))
    env.update({str(k): str(v) for k, v in settings.get("env", {}).items()})
    env.update(
        PROXY_API_KEY=KEY_FILE.read_text().strip(),
        CLAUDE_BIN=claude,
        CLAUDE_SUBSCRIPTION_DIR=str(BASE / "account"),
        CLAUDE_CWD=str(BASE / "runtime"),
        INTEGRATION_DIR=str(BASE),
        CODEX_HOME=str(CODEX_HOME),
        PORT=str(settings.get("port", DEFAULT_PORT)),
    )
    os.chdir(SOURCE)
    os.execve(bun, [bun, "run", "src/server.ts"], env)


def login(_: argparse.Namespace | None = None) -> None:
    claude = claude_path() or fail("claude not found; install Claude Code first")
    (BASE / "account").mkdir(mode=0o700, parents=True, exist_ok=True)
    subprocess.run([claude, "--setting-sources", "", "auth", "login", "--claudeai"], env=claude_env())


def enable(args: argparse.Namespace) -> None:
    save_previous_defaults()
    values = root_values(read_config())
    values["model_provider"] = json.dumps(PROVIDER)
    values["model_catalog_json"] = json.dumps(str(BASE / "models.json"))
    if getattr(args, "model", None):
        values["model"] = json.dumps(args.model)
    set_root(values)
    print("Codex now uses the bridge for new chats. Restart Codex to reload the model menu.")


def disable(_: argparse.Namespace) -> None:
    set_root(previous_defaults())
    print("Previous Codex model/provider defaults restored; other settings were kept. Restart Codex.")


def install(args: argparse.Namespace) -> None:
    bun = bun_path() or fail("bun not found; install it from https://bun.sh (curl -fsSL https://bun.sh/install | bash)")
    output = subprocess.run([bun, "--version"], capture_output=True, text=True).stdout
    if tuple(int(part) for part in re.findall(r"\d+", output)[:2]) < (1, 2):
        fail("bun 1.2 or newer is required (run `bun upgrade`)")
    if not claude_path():
        fail("claude not found; install Claude Code from https://claude.com/claude-code")
    if not CODEX_HOME.exists():
        fail(f"{CODEX_HOME} not found; install and start Codex once first")

    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    settings = load_settings()
    settings.update(source=str(SOURCE), port=args.port or settings.get("port", DEFAULT_PORT), bun=bun_path(), claude=claude_path())
    atomic_write(SETTINGS, json.dumps(settings, indent=2) + "\n")
    if not KEY_FILE.exists():
        atomic_write(KEY_FILE, secrets.token_urlsafe(48) + "\n")
    for folder in ("account", "runtime"):
        (BASE / folder).mkdir(mode=0o700, exist_ok=True)
    print(f"Integration directory: {BASE}")

    if not claude_auth().get("loggedIn"):
        if args.no_login:
            print("Claude is not logged in yet; run `python3 scripts/manage.py login` later.")
        else:
            print("Log in with your Claude account (a separate login used only by the bridge):")
            login()
            if not claude_auth().get("loggedIn"):
                fail("Claude login did not complete; run `python3 scripts/manage.py login` and then install again")

    save_previous_defaults()
    write_provider(KEY_FILE.read_text().strip())
    print(f"Codex provider `{PROVIDER}` written to {CONFIG}")

    if not args.no_service:
        install_service()
        health = wait_for_health()
        if not health:
            fail(f"the service did not start; see {ERR_LOG} and {LOG}")
        print(f"Service running on 127.0.0.1:{port()} (version {health.get('version')})")
        for _ in range(60):
            if (BASE / "models.json").exists():
                break
            time.sleep(0.5)
        else:
            print(f"warning: the model menu was not written yet; check {LOG}")

    if not args.no_enable:
        enable(args)
    print("\nDone. Restart Codex, then pick a Claude model in the model menu.")
    print("Older chats stay on GPT-only; run `python3 scripts/manage.py migrate-threads` to let them use Claude too.")


def uninstall(args: argparse.Namespace) -> None:
    if PLIST.exists() or SYSTEMD_UNIT.exists():
        remove_service()
    if CONFIG.exists():
        if PREVIOUS.exists():
            set_root(previous_defaults())
        elif root_values(read_config()).get("model_provider", "").strip("\"'") == PROVIDER:
            set_root({key: value for key, value in root_values(read_config()).items() if key not in ("model_provider", "model_catalog_json")})
        if any(CODEX_HOME.glob("state_*.sqlite")):
            restore_threads(everything=True)
        write_provider(None)
    if args.purge:
        shutil.rmtree(BASE, ignore_errors=True)
        print(f"Removed {BASE} (including the bridge's Claude login).")
    else:
        PREVIOUS.unlink(missing_ok=True)
        print(f"Bridge removed. {BASE} was kept (Claude login, backups); use --purge to delete it.")
    print("Restart Codex.")


def status(_: argparse.Namespace) -> None:
    auth = claude_auth()
    print("claude login:", json.dumps({key: auth.get(key) for key in ("loggedIn", "authMethod", "subscriptionType")}))
    try:
        print("service:", json.dumps(api("health", timeout=5)))
    except (urllib.error.URLError, OSError, ValueError, FileNotFoundError) as error:
        print(f"service: not reachable on 127.0.0.1:{port()} ({error})")
    print("codex defaults:", json.dumps(root_values(read_config())))


def refresh_models(_: argparse.Namespace) -> None:
    models = api("catalog")["models"]
    if not models or not all(isinstance(model.get("slug"), str) for model in models):
        fail("invalid model catalog")
    atomic_write(BASE / "models.json", json.dumps({"models": models}, ensure_ascii=False, indent=2) + "\n")
    print("Models:", ", ".join(model.get("display_name") or model["slug"] for model in models if model.get("visibility") != "hide"))


def logs(args: argparse.Namespace) -> None:
    os.execvp("tail", ["tail", "-n", str(args.lines), *(["-f"] if args.follow else []), str(LOG), str(ERR_LOG)])


def main() -> None:
    parser = argparse.ArgumentParser(description="Use Claude models in Codex through the official Claude Code CLI.")
    commands = parser.add_subparsers(dest="command", required=True, metavar="command")

    command = commands.add_parser("install", help="set up login, Codex provider and background service")
    command.add_argument("--port", type=int, help=f"local port (default {DEFAULT_PORT})")
    command.add_argument("--model", help="also make this the default Codex model, e.g. opus")
    command.add_argument("--no-login", action="store_true", help="skip the Claude login")
    command.add_argument("--no-service", action="store_true", help="do not install the background service")
    command.add_argument("--no-enable", action="store_true", help="do not switch Codex's default provider")
    command.set_defaults(run=install)

    command = commands.add_parser("uninstall", help="remove service and Codex settings, restore previous defaults")
    command.add_argument("--purge", action="store_true", help="also delete the integration directory and its Claude login")
    command.set_defaults(run=uninstall)

    command = commands.add_parser("enable", aliases=["use-claude"], help="make the bridge Codex's default provider")
    command.add_argument("--model", help="also make this the default model")
    command.set_defaults(run=enable)
    commands.add_parser("disable", aliases=["use-openai"], help="restore Codex's previous defaults").set_defaults(run=disable)

    commands.add_parser("status", help="show login, service and Codex defaults").set_defaults(run=status)
    commands.add_parser("login", help="log the bridge in to Claude").set_defaults(run=login)
    commands.add_parser("start", help="start the background service").set_defaults(run=lambda _: start_service())
    commands.add_parser("stop", help="stop the background service").set_defaults(run=lambda _: stop_service())
    commands.add_parser("restart", help="restart the service (drops cached Claude sessions)").set_defaults(run=lambda _: restart_service())
    commands.add_parser("serve", help="run the server in the foreground").set_defaults(run=serve)
    commands.add_parser("refresh-models", help="rewrite the Codex model menu").set_defaults(run=refresh_models)
    commands.add_parser("migrate-threads", help="let chats created before the bridge use Claude").set_defaults(run=lambda _: migrate_threads())
    commands.add_parser("restore-threads", help="undo migrate-threads").set_defaults(run=lambda _: restore_threads())
    command = commands.add_parser("logs", help="show the service log")
    command.add_argument("-n", "--lines", type=int, default=40)
    command.add_argument("-f", "--follow", action="store_true")
    command.set_defaults(run=logs)

    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
