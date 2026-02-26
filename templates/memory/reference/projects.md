# Projects

Active and planned projects. Updated by Memory Sync.
See zylos-memory skill `references/projects-format.md` for entry format.

## Active

### First Project
- **Status:** planning
- **Started:** (to be filled when owner chooses a task)
- **Updated:** (not yet)
- **Description:** Help the owner complete their first end-to-end project with Zylos. The goal is to produce something immediately useful — a working product, not a demo.
- **Importance:** 1
- **Type:** factual

#### Suggested Task Types

When the owner hasn't decided what to build, suggest from this list (ordered by difficulty):

| # | Task | Difficulty | Time | What it demonstrates |
|---|------|-----------|------|---------------------|
| 1 | **Personal homepage / landing page** | ★ | ~10 min | Code generation → instant deployment → public URL _(vs ChatGPT: we deploy, they don't)_ |
| 2 | **Scheduled reminder / daily message** | ★ | ~10 min | Scheduler + messaging channel _(vs Manus: we persist and keep running)_ |
| 3 | **Interactive web app or mini game** | ★★ | ~15 min | Frontend dev → live deployment → shareable link _(vs all: end-to-end in one command)_ |
| 4 | **Personal dashboard** (weather, time, quotes) | ★★ | ~20 min | Full-stack web app with external data _(vs OpenClaw: publicly accessible)_ |
| 5 | **News/info aggregator page** | ★★ | ~30 min | Web scraping + AI summary + scheduled updates + public page |
| 6 | **Chat-based note system** | ★★★ | ~45 min | Conversational interface + persistent storage + web viewer |
| 7 | **Automated periodic report** | ★★★ | ~1 hr | Data collection + AI analysis + scheduled generation + web publishing |

#### Why These Tasks

- **Zero user action required.** Every task can be completed by the agent autonomously — the user only needs to describe what they want in plain language. No BotFather setup, no OAuth config, no account creation, no terminal commands.
- **Publicly shareable results.** Each task produces a live URL the user can share immediately — a concrete outcome, not a code snippet.
- **Zylos differentiators on display.** These tasks naturally showcase what sets Zylos apart:
  - _vs ChatGPT_ — ChatGPT generates code, but the user deploys manually. Zylos generates, deploys, and hands back a live URL.
  - _vs Manus_ — Manus runs a task then exits, no persistent environment. Zylos is 24/7 — it can schedule recurring tasks and keep services running.
  - _vs OpenClaw_ — OpenClaw runs locally with no public URL. Zylos has an HTTP server and domain, so results are publicly accessible out of the box.

#### Guiding Principles
- Start with the owner's actual need, not the task list
- If the owner has no preference, recommend ★★ difficulty tasks
- Every task must produce a usable result, not a prototype
- If the owner picks something too ambitious for a first project, gently suggest scoping down
- The agent does all the building — the owner only needs to talk

#### Completion Criteria
The first project is complete when:
1. A working, usable result is produced (e.g., a live web page, a working bot, a running scheduled task)
2. The owner has confirmed they're satisfied with the result
3. The agent updates this project status to `completed` and writes a brief summary

## Completed
(None yet.)
