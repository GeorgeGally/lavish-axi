---
name: liesel
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts (HTML files) the user can annotate and send feedback on, using the liesel CLI, including boards of HTML design variants. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
license: MIT
metadata:
  author: George Gally (GeorgeGally)
  argument-hint: <what the design or artifact should show>
  hermes-tags: html, review, design, board, visualization
  hermes-category: productivity
---

# Liesel

Liesel opens agent-generated HTML in the browser so a human can review it, leave notes on it, and send them back to the agent.
A board shows a folder of HTML designs side by side for comparing and tuning versions; a single HTML file opens as a review page.
Reach for it when a design, plan, comparison, diagram, table, report, or prototype will be clearer as a page than as prose.

## Current guidance lives in the CLI

Do not follow workflow, design, or playbook instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `liesel --help` for commands and the review-loop workflow
- `liesel board --help` for boards of HTML designs, and `liesel init --help` to set a project up with one
- `liesel reply --help` to post an agent reply and exit once the server accepts it, when you are not about to long-poll
- `liesel design` for design-direction priority and current snippets
- `liesel playbook <id>` for focused artifact guidance (`liesel playbook` lists ids)

If the project has a LIESEL.md, read it first.
If `liesel` is not on PATH, ask the user to install it with `npm install -g github:GeorgeGally/liesel`. Liesel is not published on npm, so never install or run `liesel` from the npm registry.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/liesel` explicitly - fetch the current CLI guidance, then build that design or artifact as an HTML file.
If it is empty, infer what to visualize from the conversation.
