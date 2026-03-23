import argparse
import re
import sys
from pathlib import Path
from typing import Dict, List

import requests

PLACEHOLDER_VALUES = {
    "",
    "your_bot_token_here",
    "your_chat_id_here",
    "changeme",
    "none",
    "null",
}


def mask_value(value: str) -> str:
    if not value:
        return "<empty>"
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


def looks_like_placeholder(value: str) -> bool:
    return value.strip().lower() in PLACEHOLDER_VALUES


def read_env_lines(env_path: Path) -> List[str]:
    if not env_path.exists():
        return []
    return env_path.read_text(encoding="utf-8").splitlines(keepends=True)


def parse_env_values(lines: List[str]) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def upsert_env_values(lines: List[str], updates: Dict[str, str]) -> List[str]:
    output = list(lines)
    keys_updated = {key: False for key in updates}

    for idx, line in enumerate(output):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _ = stripped.split("=", 1)
        key = key.strip()
        if key not in updates:
            continue

        newline = "\n"
        if line.endswith("\r\n"):
            newline = "\r\n"
        output[idx] = f"{key}={updates[key]}{newline}"
        keys_updated[key] = True

    if output and not output[-1].endswith(("\n", "\r\n")):
        output[-1] = output[-1] + "\n"

    for key, value in updates.items():
        if not keys_updated[key]:
            output.append(f"{key}={value}\n")

    return output


def prompt_value(label: str, current_value: str, is_secret: bool) -> str:
    current = ""
    if current_value and not looks_like_placeholder(current_value):
        current = current_value

    while True:
        if current:
            shown = mask_value(current) if is_secret else current
            user_input = input(f"{label} [{shown}] (press Enter to keep): ").strip()
            if not user_input:
                return current
            candidate = user_input
        else:
            candidate = input(f"{label}: ").strip()

        if not candidate:
            print(f"{label} cannot be empty.")
            continue
        if looks_like_placeholder(candidate):
            print(f"{label} still looks like a placeholder. Please enter a real value.")
            continue
        return candidate


def validate_token(token: str) -> str:
    if any(ch.isspace() for ch in token):
        return "Token contains whitespace. Remove spaces/newlines from TELEGRAM_BOT_TOKEN."
    if ":" not in token:
        return "Token format looks invalid. Expected pattern like 123456:ABCDEF..."
    return ""


def validate_chat_id(chat_id: str) -> str:
    if not re.fullmatch(r"-?\d+", chat_id):
        return "Chat ID should be numeric (for groups it is often negative)."
    return ""


def send_test_message(token: str, chat_id: str) -> int:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": "Trading engine Telegram setup test: OK",
        "disable_notification": True,
    }
    response = requests.post(url, json=payload, timeout=10)
    return response.status_code, response.text


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env."
    )
    parser.add_argument("--token", help="Telegram bot token")
    parser.add_argument("--chat-id", help="Telegram chat ID")
    parser.add_argument(
        "--env-file",
        default=".env",
        help="Path to .env file (default: .env in current directory)",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Send a Telegram test message after saving values",
    )
    args = parser.parse_args()

    env_path = Path(args.env_file).expanduser().resolve()
    lines = read_env_lines(env_path)
    existing = parse_env_values(lines)

    token = args.token or prompt_value(
        "TELEGRAM_BOT_TOKEN", existing.get("TELEGRAM_BOT_TOKEN", ""), is_secret=True
    )
    chat_id = args.chat_id or prompt_value(
        "TELEGRAM_CHAT_ID", existing.get("TELEGRAM_CHAT_ID", ""), is_secret=False
    )

    token_error = validate_token(token)
    chat_error = validate_chat_id(chat_id)
    if token_error:
        print(f"Error: {token_error}")
        return 1
    if chat_error:
        print(f"Error: {chat_error}")
        return 1

    updates = {"TELEGRAM_BOT_TOKEN": token, "TELEGRAM_CHAT_ID": chat_id}
    new_lines = upsert_env_values(lines, updates)

    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("".join(new_lines), encoding="utf-8")

    print(f"Updated: {env_path}")
    print(f"TELEGRAM_BOT_TOKEN={mask_value(token)}")
    print(f"TELEGRAM_CHAT_ID={chat_id}")

    if args.test:
        status, body = send_test_message(token, chat_id)
        if status == 200:
            print("Telegram test message sent successfully.")
        elif status == 404:
            print("Telegram test failed (404): bot token is invalid.")
            print(body)
            return 1
        elif status == 400:
            print("Telegram test failed (400): check chat ID and bot access to the chat.")
            print(body)
            return 1
        else:
            print(f"Telegram test failed ({status}).")
            print(body)
            return 1

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
