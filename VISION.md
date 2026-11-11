# Vision

Liesel lets a person review what a coding agent made by pointing at it, and makes sure the agent understands exactly what they meant.
The agent runs Liesel. The person points, selects, tunes, moves, draws and types, and Liesel turns that into notes the agent receives in the person's own words.

Liesel started as a review loop over one local HTML file. It is now a local board for HTML designs and for a project's running pages. This file draws the line around that product, so a change that crosses the line is easy to spot.

## What Liesel is today

- **A board.** A folder (`board.json` plus one HTML file per design) shown in the browser at real device widths, with tabs, versions side by side, a line of builds and History, Duplicate, Accept and Final.
- **Project previews.** A board for a real project: its running dev server, shown through a local proxy in the same device frames, with notes that carry the page path and selector so the agent edits the project's own source.
- **Notes to agents.** Pins on elements, text selections, table cells, diagram nodes, image drops and chat messages. Each note goes to the agent with what it points at, a picture of the spot and the viewport width, and shows Seen, Working and Done as the agent picks it up.
- **View, Chat, Edit and Move.** Edit tunes a page's custom properties or one element's type, colour, spacing and size. Move drags an element. Both are previews kept on the board, and **Send** hands the change to the agent as a note.
- **Ways to reach the agent.** The CLI long poll (`liesel poll`), an MCP server (`liesel mcp`) that wraps the same loop for chat apps, a notify command, and an agent runner that starts one headless agent run per send for a board whose reviewer picked an agent in Settings.
- **The single-file review.** `liesel <html-file>` still opens one artifact in the review chrome, with layout warnings, whiteboards for Mermaid diagrams, export and opt-in sharing.

## Is / is not

Liesel **is**:

- a review surface between one person and the agents working on their HTML designs and project pages;
- local: one server on the user's machine, reachable from their own devices (loopback, and Tailscale when it is running);
- a channel that carries the person's intent to an agent: notes, picks, tunes and moves, all as notes the agent reads;
- a way to compare versions of a design and see what changed between builds;
- a place where Edit and Move preview a change on the board and hand it to the agent, who makes the real edit;
- able to start one headless agent run per send, when the reviewer picked that agent for the board;
- an MCP server that exposes the same open, poll and reply loop the CLI already has.

Liesel **is not**:

- a design tool or page builder: it never writes a tune, a move or a dropped image into a design file or a project's source, and the agent does all source edits;
- an agent supervisor: it does not plan work, retry failed runs, run several agents on one board, keep a task queue or decide when work is finished;
- a collaboration space for two or more people;
- a hosting service: publishing goes only to a named third party, never by default;
- a code editor, an IDE or a deploy tool;
- a reviewer of Markdown, PDFs or images that have no HTML file behind them;
- a marketplace or a plugin host.

## How Liesel behaves

**The file stays the author's.** The design file or project source on disk is the truth. Liesel serves it with its own script added and nothing else, and Liesel's own drawing (pins, tags, outlines, guides) never ends up in the saved page, History or an export. Tunes, moves and image drops live in `board.json` until the agent applies them.

**Only the person's actions become work.** Detection is passive and fails open. A layout warning or any other finding is shown to the person and never wakes the agent, returns a poll or repairs anything. The one exception is a failure that leaves the person nothing to review.

**Nothing interrupts the person.** Time to the first interaction is the number that matters. A check that blocks the review, edits the page or nags is removed.

**Interaction beats prose.** A page earns its format by letting the reader answer through the page. A page that could have been a paragraph should have been one.

**Design is chosen, not defaulted.** An agent picks a design direction in a stated order and says which source it used. A page matches the project it is about before it matches anything Liesel prefers.

**Every token is spent on purpose.** Output is compact, waiting is a long poll, and guidance is shown when it is needed. Each contract has one owner surface (the CLI output for agents, README for users), and every other surface points at it.

**Liesel touches only its own files unless asked.** It keeps its state in its own places (`~/.liesel`, a board folder, a project's `.liesel/`). It changes a file the user or another tool owns only when a command the user ran says it will (`liesel init`, `liesel setup hooks`, `liesel setup plugin`).

**Anything that leaves the machine is opt-in, named and disclosed when it happens.**

## A change fits when

it carries the person's intent to the agent more exactly, keeps the file on disk the truth, keeps the review uninterrupted, and lands in the one surface that already owns the contract it touches.

A change should be resisted when it edits a design or source file without the agent, acts without the person asking, makes Liesel decide or schedule the agent's work, adds a second person to the loop, or sends something off the machine without saying so.

## Next

These two features are in the vision and are queued:

- **Source-aware inspection.** Map a selected element to the component and source file that render it, so a note on a project page names where to make the change, not only a selector.
- **A structured change contract for tune handoffs.** Send hands the agent each Edit and Move change as a defined record (element, property, old and new value, scope, device size) instead of loose CSS, so the agent can apply it without guessing.

## Open questions

The source does these today. Their place in the vision is not decided yet:

- **Project setup runs code and uses the network.** Opening a project can clone a GitHub repository, install its dependencies and run its dev command. Is that inside "opt-in, named and disclosed", and should Liesel ask first?
- **`.git/info/exclude`.** Opening a project adds `/.liesel/` to the repository's exclude file without a separate prompt. Is that Liesel's own file, or a file it should ask before changing?
- **Google Fonts in the font picker.** Picking a Google font loads it from Google into the design frame. Is that an outbound request that needs disclosing?
- **The agent runner's edge.** One headless run per send is in. Where it stops (retries, choosing a model, running several boards' agents at once, long-running runs) is not settled.
- **The single-file review and the board.** Both are kept and work differently (layout warnings, whiteboards and sharing exist only in the single-file review). Should one become a mode of the other?
- **Whiteboards.** Mermaid diagrams become editable Excalidraw whiteboards in the single-file review. Do they belong on boards too, or stay where they are?
- **Hosted sharing.** `liesel share` publishes to ht-ml.app. It is opt-in and named, but is publishing still part of a local review tool?
