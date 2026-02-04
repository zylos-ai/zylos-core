# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Standards

### Programming Language

- **Language**: Node.js (JavaScript)
- **Runtime**: Node.js 20+

### Module System

**This project is ESM-only.**

- ✅ Always use `import` / `export`
- ❌ Do NOT use CommonJS (`require`, `module.exports`)
- ❌ Do NOT mix module systems

**Examples:**

```javascript
// ✅ Correct (ESM)
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

export function myFunction() {
  // ...
}

export default myClass;
```

```javascript
// ❌ Wrong (CommonJS)
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = myFunction;
```

## Project Structure

- `skills/` - Claude Code skills (modular workflows)
- `cli/` - Command-line interface tools

## Skills

Each skill is a self-contained module in `skills/<skill-name>/`:
- `SKILL.md` - Skill documentation (YAML frontmatter + usage guide)
- `<skill-name>.js` - Main implementation (ESM)
- Other supporting files as needed

### SKILL.md Format

```markdown
---
name: skill-name
description: Use when [trigger condition].
---

# Skill Name

[Brief description]

## When to Use

- [Trigger condition 1]
- [Trigger condition 2]

## How to Use

[Usage instructions with code examples]

## How It Works

[Technical explanation]
```
