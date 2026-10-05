# nosleep-mcp-research

MCP server that exposes NotebookLM as research tools for Claude Code sessions. Offloads documentation lookup, code research, and knowledge synthesis to NotebookLM's Gemini backend, saving Claude tokens.

## Prerequisites

- Python 3.11+
- A Google account with access to NotebookLM

## Installation

```bash
cd packages/mcp-research
pip install -e .
```

## Authentication

This package uses `notebooklm-py`, which authenticates via Playwright browser automation with saved cookies (not API keys).

### First-time setup

1. Run the auth helper to open a browser and log in to Google:

   ```bash
   python -m nosleep_research.auth
   ```

2. Sign in to your Google account in the browser window that opens.

3. The session cookies are saved to `~/.notebooklm/storage_state.json`.

### Custom auth path

Set `NOTEBOOKLM_AUTH_JSON` to point to a different `storage_state.json` location:

```bash
export NOTEBOOKLM_AUTH_JSON=/path/to/storage_state.json
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NOSLEEP_ORG_ID` | Yes | Organization ID for notebook isolation |
| `NOSLEEP_DB_PATH` | No | Path to SQLite DB for query logging (defaults to `./research.db`) |
| `NOTEBOOKLM_AUTH_JSON` | No | Path to `storage_state.json` (auto-detects `~/.notebooklm/`) |

## Running the MCP Server

```bash
nosleep-research
```

The server uses stdio transport. Add it to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "research": {
      "command": "nosleep-research",
      "env": {
        "NOSLEEP_ORG_ID": "org_personal"
      }
    }
  }
}
```

## Tools

- **research_query** - Ask NotebookLM a question grounded in your sources
- **research_add_source** - Add a URL, text, or file to a notebook
- **research_create_notebook** - Create a new notebook for a topic/project
- **research_list_notebooks** - List all notebooks in the org
- **research_generate_summary** - Generate a mind map, report, or outline
- **research_get_sources** - List sources in a notebook
