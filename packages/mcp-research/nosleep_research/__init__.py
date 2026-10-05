"""NoSleep MCP Research Server - NotebookLM integration for Claude Code."""

from nosleep_research.server import create_server


def main() -> None:
    """Entry point for the nosleep-research MCP server."""
    import asyncio

    asyncio.run(_run())


async def _run() -> None:
    """Start the MCP server with stdio transport."""
    from mcp.server.stdio import stdio_server

    server = create_server()

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())
