---
name: auto-capture
description: |
  When a work session is wrapping up, save its important outcomes to the
  NoSleep Brain: one thought per must-do follow-up plus a short session
  recap. Use when the user signals they are stopping, parking a project, or
  ending a brainstorm with decisions worth keeping. Uses the capture_thought
  tool on the nosleep-brain-<org> MCP server. This is a protocol for you to
  follow, not a background hook.
author: NoSleep
version: 2.0.0
---

# Auto-Capture

Sessions end, context is lost, and the decisions made in them vanish unless
someone writes them down. This skill makes writing them down the default.

## When to run

- The user signals the end of a session ("wrap up", "park this",
  "goodnight", "let's stop here", "that's it for now").
- A session produced follow-ups that must not be forgotten (ACT NOW items).
- A long session is closing and its results are worth keeping.
- The NoSleep supervision loop sent a `session_end` event.

## Steps

1. **Pick what matters.** List the ACT NOW items: follow-ups that need doing
   soon. Then draft a single recap of the session.
2. **Check for duplicates.** For each item, call
   `search_thoughts(query, project_id)` with its first line. If an existing
   thought already says the same thing, don't capture it again; mention that
   you skipped it.
3. **Save each ACT NOW item** with `capture_thought`:
   - `content`: a self-contained statement of the item, why it matters, and
     two or three concrete next steps.
   - `project_id`: the project this session belongs to (always pass it).
   - `thought_type_hint`: one of
     `observation | task | idea | reference | person_note | decision | insight | question`.
   - `source_refs` (optional): when a specific archive artifact led to the
     item, pass `[{hash, relation: "distilled_from"}]` to link back to it.
4. **Save the recap** with `capture_thought`:
   - `content`: the goal of the session, what was decided, how many follow-ups
     came out of it, and where more detail lives (file paths, PRs).
   - `thought_type_hint`: `observation` or `insight`.
5. **Leave out noise:** transcript excerpts, ideas that were dropped, and
   anything already captured.

## Result

At the end there is one Brain thought per ACT NOW item and one recap thought.
Each should make sense to someone reading it months later, without the
original session.

## Guidance

- Be concrete. "Move webhook retries to a queue with exponential backoff" is
  useful; "talked about the API" is not.
- If `capture_thought` errors, say so plainly. Never report a capture that
  didn't happen.
- Tool names carry the MCP server prefix (`nosleep-brain-<org>`). Use the one
  connected to this session.
