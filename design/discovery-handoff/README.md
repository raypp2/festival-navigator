# CODING AGENTS: READ THIS FIRST

This is a **handoff bundle** from Claude Design (claude.ai/design).

A user mocked up designs in HTML/CSS/JS using an AI design tool, then exported this bundle so a coding agent can implement the designs for real.

## THIS BUNDLE IS A MIRROR, AND IT GOES STALE

The design of record is the live Claude Design project
**`952108d2-3628-4de1-b9a6-40f0c4169e49`**
(<https://claude.ai/design/p/952108d2-3628-4de1-b9a6-40f0c4169e49>). Ray edits it
there, so this directory drifts behind it silently — it was last re-synced
**2026-08-02**. Before implementing anything from these files, pull the current
version with the `DesignSync` tool (`list_files`, then `get_file`) and diff it
against what is here. Do not assume this copy is current just because it is
committed.

Diffing cheaply: a `get_file` on a large file is persisted to a tool-results
file rather than your context — decode it with `json.load(...)['content']` and
`difflib` it against the mirror after splitting on `>\s*<`, which turns a 165KB
frame file into a few hundred readable lines. For smaller files that come back
inline, grep this copy for a distinctive new phrase to confirm what moved.

## What you should do — IMPORTANT

**Read `project/Discovery - Screens.dc.html` in full.** It carries the signed-off
phone and desktop-1440 frames and is the primary design. Read it top to bottom —
don't skim. `project/Discovery - Style Guide.dc.html` holds the tokens and the
settled component rules; `project/Discovery - Swipe Demo.dc.html` is the
interactive mobile deck and is the motion reference.

**`project/support.js` is the generated Claude Design runtime** (a React shim,
`DCLogic`, the `sc-if`/`sc-for` directives). It is marked "do not edit", carries
no design decisions, and reading its 69KB is wasted context — skip it.

**If anything is ambiguous, ask the user to confirm before you start implementing.** It's much cheaper to clarify scope up front than to build the wrong thing.

## About the design files

The design medium is **HTML/CSS/JS** — these are prototypes, not production code. Your job is to **recreate them pixel-perfectly** in whatever technology makes sense for the target codebase (React, Vue, native, whatever fits). Match the visual output; don't copy the prototype's internal structure unless it happens to fit.

**Don't render these files in a browser or take screenshots unless the user asks you to.** Everything you need — dimensions, colors, layout rules — is spelled out in the source. Read the HTML and CSS directly; a screenshot won't tell you anything they don't.

## Bundle contents

- `README.md` — this file
- `project/` — the design project files (HTML prototypes, assets, components)

(The original export nested these under an `exploring-fourteen-layout-directions/`
directory. They were flattened when committed; paths above are the real ones.)
