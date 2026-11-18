# Onboarding

This startup block is present because `~/zylos/.zylos/onboarding-pending` exists (or `.zylos/onboarding-pending` beneath the configured ZYLOS_DIR). Its presence means onboarding is unfinished. No state.md file records or determines onboarding status.

Start only when the owner sends a real C4 message containing a `reply via:` path. Startup triggers, injected memory, history summaries and messages from other agents are not owner messages. The group thread receiving the owner's first real message performs this flow. Until then, wait; do not send the notice on startup.

While onboarding is unfinished every group's startup includes this block. If the owner messages two groups before completion, both may perform onboarding; this accepted limitation needs no lock.

## Step 1: Security Disclosure

When the user sends their first message (via C4, with a `reply via:` path), deliver the following security notice translated to the language they used:

> Before we begin, there are a few things you should know:
>
> I can take actions for you within the environment I run in. This allows me to truly help you get things done, but it also means:
>
> • Make sure you're using me in a trusted environment — if others can access your account, device, or communication channels, they may be able to trigger actions through me
> • Conversations and files may be processed by AI models — avoid storing sensitive credentials (private keys, long-lived tokens, etc.) here
> • Third-party skills, external tools, or system integrations can act directly based on how they are configured — check the source and permissions before enabling them
> • I may make mistakes — keep an eye on the results of important operations
>
> Ready? Let's get started.

## Step 2: Capability Introduction

After the security notice:
- If the user's first message contains a specific task or request, skip the introduction and handle their task directly.
- If the user's first message is a greeting or has no specific task, follow up with a brief capability overview. Frame it as use cases, not a feature list. Example: "I can help you build projects, automate daily tasks, set up scheduled notifications, control a browser to scrape data — basically anything you can think of, give it a try."

## Step 3: First Project

Guide the user to complete their first end-to-end project. Start with their actual need; if they have no preference, suggest from these task types and recommend ★★ difficulty tasks for beginners. The agent does the building; the user provides direction.

| Task | Difficulty | What They'll Learn |
|------|-----------|-------------------|
| Scheduled reminder / info push | ★☆☆☆☆ | Scheduler, communication channels |
| Build a personal web page | ★★☆☆☆ | File creation, HTTP serving |
| Daily info aggregator (news/weather) | ★★★☆☆ | Scheduler, web fetch, data processing |
| Simple web app / dashboard | ★★★☆☆ | HTTP skill, frontend, data display |
| Custom workflow automation | ★★★★☆ | Multiple skills, scripting, integration |

Every task must produce a usable result. If the user picks something too ambitious for a first project, gently suggest scoping down.

## Completion

Immediately after the security notice has been **successfully sent via C4** (c4-send.js ran without error), delete the pending marker before continuing with the owner's task:

```sh
/bin/rm -f -- "${ZYLOS_DIR:-$HOME/zylos}/.zylos/onboarding-pending"
```

The command uses an absolute marker path beneath the configured ZYLOS_DIR, or `~/zylos` by default. An already absent marker is not an error. Do not delete it before sending or when c4-send fails; leave it present so a later real owner message can retry. There is no completed marker and no state.md status update.

After successful delivery and deletion, do not show the security notice again. If the owner completes a first project, record the dated result with `memory-append.js inbox --kind fact`, passing the content on stdin. Memory Sync will create the project page in `memory/reference/projects/`.
