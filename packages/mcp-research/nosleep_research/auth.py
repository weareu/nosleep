"""Authentication helper for NotebookLM via notebooklm-py."""

from __future__ import annotations

import os
from pathlib import Path


DEFAULT_AUTH_DIR = Path.home() / ".notebooklm"
DEFAULT_AUTH_FILE = DEFAULT_AUTH_DIR / "storage_state.json"


def get_auth_path() -> Path:
    """Resolve the storage_state.json path in priority order.

    Priority:
    1. NOTEBOOKLM_AUTH_JSON environment variable
    2. ~/.notebooklm/storage_state.json

    Returns:
        Path to storage_state.json

    Raises:
        FileNotFoundError: If no valid auth file is found.
    """
    env_path = os.environ.get("NOTEBOOKLM_AUTH_JSON")
    if env_path:
        path = Path(env_path)
        if path.is_file():
            return path
        raise FileNotFoundError(
            f"NOTEBOOKLM_AUTH_JSON points to non-existent file: {env_path}"
        )

    if DEFAULT_AUTH_FILE.is_file():
        return DEFAULT_AUTH_FILE

    raise FileNotFoundError(
        "No NotebookLM auth found. Run 'python -m nosleep_research.auth' "
        "to authenticate, or set NOTEBOOKLM_AUTH_JSON."
    )


def validate_auth() -> bool:
    """Check whether a valid auth file exists.

    Returns:
        True if auth file exists and is readable.
    """
    try:
        path = get_auth_path()
        return path.is_file() and path.stat().st_size > 0
    except FileNotFoundError:
        return False


async def run_browser_login() -> Path:
    """Open a browser window for the user to log in to Google/NotebookLM.

    Uses Playwright to open a real browser. The user signs in to their Google
    account, and the session cookies are saved to ~/.notebooklm/storage_state.json.

    Returns:
        Path to the saved storage_state.json.
    """
    from playwright.async_api import async_playwright

    DEFAULT_AUTH_DIR.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto("https://notebooklm.google.com/")

        print("\n  A browser window has opened.")
        print("  Please sign in to your Google account.")
        print("  Once you see the NotebookLM dashboard, press ENTER here.\n")

        # Wait for user to complete login - poll for the dashboard URL
        import asyncio
        while True:
            url = page.url
            if "notebooklm.google.com" in url and "login" not in url.lower() and "accounts.google" not in url:
                # Looks like they're on the dashboard
                print(f"  Detected NotebookLM page: {url}")
                print("  Waiting 3 seconds for cookies to settle...")
                await asyncio.sleep(3)
                break
            await asyncio.sleep(1)

        # Save the storage state (cookies + localStorage)
        await context.storage_state(path=str(DEFAULT_AUTH_FILE))
        await browser.close()

    return DEFAULT_AUTH_FILE


if __name__ == "__main__":
    import asyncio

    print("Opening browser for NotebookLM authentication...")
    path = asyncio.run(run_browser_login())
    print(f"\nAuth saved to: {path}")
    print("You can now use the MCP Research server.")
