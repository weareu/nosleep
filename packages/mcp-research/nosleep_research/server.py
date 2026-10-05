"""MCP server exposing NotebookLM as research tools for Claude Code sessions."""

from __future__ import annotations

import os
import uuid
from contextlib import asynccontextmanager
from typing import Any

from mcp.server import Server
from mcp.types import TextContent, Tool

from nosleep_research.auth import get_auth_path
from nosleep_research.notebook_registry import NotebookRegistry


def _get_org_id() -> str:
    org_id = os.environ.get("NOSLEEP_ORG_ID")
    if not org_id:
        raise RuntimeError("NOSLEEP_ORG_ID environment variable is required")
    return org_id


@asynccontextmanager
async def _notebooklm_client():
    """Create an async context-managed NotebookLMClient from stored auth."""
    from notebooklm import NotebookLMClient

    auth_path = get_auth_path()
    async with await NotebookLMClient.from_storage(path=str(auth_path)) as client:
        yield client


def _estimate_tokens_saved(response_text: str) -> int:
    """Estimate tokens saved by using NotebookLM instead of sending full sources to Claude.

    Rough heuristic: NotebookLM answers are typically distilled from 10-50x more source
    material. We estimate 4 chars per token and a 10x compression ratio.
    """
    response_tokens = len(response_text) // 4
    return response_tokens * 10


def create_server() -> Server:
    """Create and configure the MCP research server."""
    server = Server("nosleep-research")
    registry = NotebookRegistry()

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name="research_query",
                description=(
                    "Ask NotebookLM a question grounded in your sources. "
                    "This is the primary research tool - saves Claude tokens by "
                    "offloading documentation lookup to NotebookLM's Gemini backend."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The research question to ask",
                        },
                        "notebook_id": {
                            "type": "string",
                            "description": "Notebook ID to query (uses default org notebook if omitted)",
                        },
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="research_add_source",
                description="Add a URL, file, or text to a NotebookLM notebook for future queries.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "source_type": {
                            "type": "string",
                            "enum": ["url", "text", "file"],
                            "description": "Type of source to add",
                        },
                        "content": {
                            "type": "string",
                            "description": "URL, text content, or file path to add",
                        },
                        "title": {
                            "type": "string",
                            "description": "Title for text sources (required for text type)",
                        },
                        "notebook_id": {
                            "type": "string",
                            "description": "Target notebook ID (uses default org notebook if omitted)",
                        },
                    },
                    "required": ["source_type", "content"],
                },
            ),
            Tool(
                name="research_create_notebook",
                description="Create a new NotebookLM notebook for a specific topic or project.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "Title for the new notebook",
                        },
                        "project_id": {
                            "type": "string",
                            "description": "Optional NoSleep project ID to link this notebook to",
                        },
                    },
                    "required": ["title"],
                },
            ),
            Tool(
                name="research_list_notebooks",
                description="List all NotebookLM notebooks in the current org.",
                inputSchema={
                    "type": "object",
                    "properties": {},
                },
            ),
            Tool(
                name="research_generate_summary",
                description="Generate a structured summary of sources in a notebook.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "notebook_id": {
                            "type": "string",
                            "description": "Notebook ID to summarize",
                        },
                        "format": {
                            "type": "string",
                            "enum": ["mind_map", "report", "outline"],
                            "description": "Summary format",
                        },
                    },
                    "required": ["notebook_id", "format"],
                },
            ),
            Tool(
                name="research_get_sources",
                description="List all sources in a NotebookLM notebook.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "notebook_id": {
                            "type": "string",
                            "description": "Notebook ID to list sources for",
                        },
                    },
                    "required": ["notebook_id"],
                },
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
        org_id = _get_org_id()

        if name == "research_query":
            return await _handle_research_query(registry, org_id, arguments)
        elif name == "research_add_source":
            return await _handle_add_source(registry, org_id, arguments)
        elif name == "research_create_notebook":
            return await _handle_create_notebook(registry, org_id, arguments)
        elif name == "research_list_notebooks":
            return await _handle_list_notebooks(registry, org_id)
        elif name == "research_generate_summary":
            return await _handle_generate_summary(registry, org_id, arguments)
        elif name == "research_get_sources":
            return await _handle_get_sources(registry, org_id, arguments)
        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]

    return server


async def _resolve_notebook(
    registry: NotebookRegistry, org_id: str, notebook_id: str | None
) -> tuple[str, str]:
    """Resolve a notebook_id to (registry_id, notebooklm_id).

    If notebook_id is None, uses the default org notebook.
    Creates a default notebook if none exists.
    """
    if notebook_id:
        record = registry.get_notebook(notebook_id, org_id)
        if record is None:
            raise ValueError(f"Notebook '{notebook_id}' not found for org '{org_id}'")
        return record.id, record.notebook_lm_id

    record = registry.get_default_notebook(org_id)
    if record:
        return record.id, record.notebook_lm_id

    # Create default notebook on first use
    async with _notebooklm_client() as client:
        nb = await client.notebooks.create(title="general")
        reg_id = f"nb_{uuid.uuid4().hex[:12]}"
        registry.register_notebook(
            notebook_id=reg_id,
            org_id=org_id,
            notebook_lm_id=nb.id,
            title="general",
        )
        return reg_id, nb.id


async def _handle_research_query(
    registry: NotebookRegistry, org_id: str, args: dict[str, Any]
) -> list[TextContent]:
    query: str = args["query"]
    notebook_id_arg: str | None = args.get("notebook_id")

    try:
        reg_id, lm_id = await _resolve_notebook(registry, org_id, notebook_id_arg)
    except ValueError as exc:
        return [TextContent(type="text", text=str(exc))]

    async with _notebooklm_client() as client:
        response = await client.chat.ask(lm_id, query)

    answer_text = response.answer if hasattr(response, "answer") else str(response)
    sources_cited = len(response.references) if hasattr(response, "references") else 0
    estimated_saved = _estimate_tokens_saved(answer_text)

    registry.mark_queried(reg_id)
    registry.log_query(
        org_id=org_id,
        notebook_id=reg_id,
        query=query,
        response_summary=answer_text[:500],
        sources_cited=sources_cited,
        estimated_tokens_saved=estimated_saved,
    )

    return [TextContent(type="text", text=answer_text)]


async def _handle_add_source(
    registry: NotebookRegistry, org_id: str, args: dict[str, Any]
) -> list[TextContent]:
    source_type: str = args["source_type"]
    content: str = args["content"]
    title: str = args.get("title", "Untitled")
    notebook_id_arg: str | None = args.get("notebook_id")

    try:
        reg_id, lm_id = await _resolve_notebook(registry, org_id, notebook_id_arg)
    except ValueError as exc:
        return [TextContent(type="text", text=str(exc))]

    async with _notebooklm_client() as client:
        if source_type == "url":
            source = await client.sources.add_url(lm_id, url=content, wait=True)
        elif source_type == "text":
            source = await client.sources.add_text(lm_id, title=title, content=content, wait=True)
        elif source_type == "file":
            source = await client.sources.add_file(lm_id, file_path=content, wait=True)
        else:
            return [TextContent(type="text", text=f"Invalid source_type: {source_type}")]

        # Update source count in registry
        sources = await client.sources.list(lm_id)
        registry.update_source_count(reg_id, len(sources))

    source_title = source.title if hasattr(source, "title") else source_type
    return [TextContent(
        type="text",
        text=f"Source added: {source_title} ({source_type})",
    )]


async def _handle_create_notebook(
    registry: NotebookRegistry, org_id: str, args: dict[str, Any]
) -> list[TextContent]:
    title: str = args["title"]
    project_id: str | None = args.get("project_id")

    async with _notebooklm_client() as client:
        nb = await client.notebooks.create(title=title)

    reg_id = f"nb_{uuid.uuid4().hex[:12]}"
    registry.register_notebook(
        notebook_id=reg_id,
        org_id=org_id,
        notebook_lm_id=nb.id,
        title=title,
        project_id=project_id,
    )

    return [TextContent(
        type="text",
        text=f"Notebook created: {title} (id: {reg_id})",
    )]


async def _handle_list_notebooks(
    registry: NotebookRegistry, org_id: str
) -> list[TextContent]:
    notebooks = registry.list_notebooks(org_id)

    if not notebooks:
        return [TextContent(type="text", text="No notebooks found for this org.")]

    lines = [f"Notebooks for org {org_id}:", ""]
    for nb in notebooks:
        project_info = f" [project: {nb.project_id}]" if nb.project_id else ""
        queried_info = f" (last queried: {nb.last_queried_at})" if nb.last_queried_at else ""
        lines.append(
            f"- {nb.title} (id: {nb.id}, sources: {nb.source_count}){project_info}{queried_info}"
        )

    return [TextContent(type="text", text="\n".join(lines))]


async def _handle_generate_summary(
    registry: NotebookRegistry, org_id: str, args: dict[str, Any]
) -> list[TextContent]:
    notebook_id_arg: str = args["notebook_id"]
    summary_format: str = args["format"]

    try:
        reg_id, lm_id = await _resolve_notebook(registry, org_id, notebook_id_arg)
    except ValueError as exc:
        return [TextContent(type="text", text=str(exc))]

    format_prompts = {
        "mind_map": "Create a mind map of the key concepts and their relationships from the sources.",
        "report": "Write a structured report summarizing the key findings from the sources.",
        "outline": "Create a hierarchical outline of the main topics covered in the sources.",
    }

    prompt = format_prompts.get(summary_format, format_prompts["outline"])

    async with _notebooklm_client() as client:
        response = await client.chat.ask(lm_id, prompt)

    answer_text = response.answer if hasattr(response, "answer") else str(response)

    registry.log_query(
        org_id=org_id,
        notebook_id=reg_id,
        query=f"[summary:{summary_format}]",
        response_summary=answer_text[:500],
        estimated_tokens_saved=_estimate_tokens_saved(answer_text),
    )

    return [TextContent(type="text", text=answer_text)]


async def _handle_get_sources(
    registry: NotebookRegistry, org_id: str, args: dict[str, Any]
) -> list[TextContent]:
    notebook_id_arg: str = args["notebook_id"]

    try:
        _, lm_id = await _resolve_notebook(registry, org_id, notebook_id_arg)
    except ValueError as exc:
        return [TextContent(type="text", text=str(exc))]

    async with _notebooklm_client() as client:
        sources = await client.sources.list(lm_id)

    if not sources:
        return [TextContent(type="text", text="No sources in this notebook.")]

    lines = ["Sources:", ""]
    for src in sources:
        title = src.title if hasattr(src, "title") else "Untitled"
        src_type = src.type.value if hasattr(src, "type") else "unknown"
        lines.append(f"- {title} ({src_type})")

    return [TextContent(type="text", text="\n".join(lines))]
