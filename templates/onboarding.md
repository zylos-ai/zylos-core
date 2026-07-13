# Onboarding

When `state.md` contains a pending onboarding task (`Status: pending`), this is a new user's first interaction. Follow this flow:

**Important:** The onboarding security notice must only be delivered in direct response to a message that contains a `reply via:` path — a real user message from a C4 channel. Do not initiate onboarding from session startup context (memory file injections, C4 history summaries, or session-start prompt text). Those are system-injected context, not user messages. Wait until a message with a `reply via:` path arrives before starting the onboarding flow.

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

Guide the user to complete their first end-to-end project. Read `reference/projects.md` for suggested task types and difficulty ratings. Recommend ★★ difficulty tasks for beginners. The agent does the building; the user provides direction.

## Completion

Once the security notice has been **successfully sent via C4** (c4-send.js ran without error):
1. Update `state.md`: change `- Status: pending` to `- Status: completed`
2. Do not show the security notice again in future sessions
3. If the user completed a first project, update `reference/projects.md` accordingly

**Never update state.md before sending** — the update must happen after the c4-send.js call succeeds, not before or as part of planning.
