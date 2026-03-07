# Content Engine: Agent Orchestrator -- 3.8K to 50K Stars in 12 Months

**Author perspective:** Lena Voss -- dev content creator (150K YT / 80K X)
**Date:** March 2026

---

## 1. Twenty Content Pieces Ranked by Viral Potential

### Tier S -- "Stop Scrolling" Potential (500K+ reach each)

| # | Title | Format | Platform | Est. Reach | Why It Works |
|---|-------|--------|----------|------------|--------------|
| 1 | "I Control 30 AI Agents From My Phone (Telegram)" | 60s vertical video + thread | X, TikTok, YT Shorts | 800K-2M | Phone screen recording is instantly relatable. Nobody expects Telegram as an agent interface. Dissonance = virality. |
| 2 | "I Gave AI Agents My Entire Jira Board (They Cleared It)" | 8-min YouTube + 90s cut | YouTube + X clip | 600K-1.2M | Before/after Jira board is a visual gut punch. Every dev hates Jira. "AI does your tickets" is a dream. |
| 3 | "30 AI Agents, 30 PRs, 1 Human -- Full Livestream" | 2-hour YouTube Live + highlights | YouTube Live + clips | 400K-800K | The spectacle factor. Nobody has shown fleet-scale agent work in real time. Chat participation drives retention. |

### Tier A -- High Viral Probability (200K-500K reach)

| # | Title | Format | Platform | Est. Reach | Why It Works |
|---|-------|--------|----------|------------|--------------|
| 4 | "The Tool That Makes Cursor Look Like Notepad" | 12-min comparison video | YouTube | 300K-500K | Clickbait that delivers. Comparing against the $29B gorilla guarantees search traffic and arguments in comments. |
| 5 | "I Left 10 Agents Running Overnight. Here's What I Found." | Thread (8 tweets) + blog | X + dev.to | 250K-400K | Narrative tension. "What happened?" drives clicks. Overnight = no human intervention = the whole pitch. |
| 6 | "Why I Stopped Using Cursor for Multi-File Changes" | 10-min YouTube | YouTube | 200K-400K | Counter-narrative to the Cursor hype. Search traffic from "Cursor alternatives." Positions AO as the grown-up choice. |
| 7 | "My AI Agent Texted Me From the Subway to Ask About a Failing Test" | Single tweet with phone screenshot | X | 200K-350K | Anthropomorphizing the agent ("texted me") + relatable commute scenario. Screenshot is the proof. |
| 8 | "Kubernetes for AI Agents Exists and Nobody's Talking About It" | Thread (10 tweets) | X | 200K-300K | Category-naming tweet. "Kubernetes for X" is a proven framing that the tech crowd can't resist debating. |

### Tier B -- Solid Performers (50K-200K reach)

| # | Title | Format | Platform | Est. Reach | Why It Works |
|---|-------|--------|----------|------------|--------------|
| 9 | "How the Inbound Context System Routes Telegram Messages to the Right Agent" | Technical blog post | HN + dev.to | 80K-200K | HN loves architecture deep-dives. The FIFO queue + file locking + deduplication is genuinely interesting engineering. |
| 10 | "I Built a Bot That Auto-Assigns Jira Tickets to AI Agents" | 5-min demo video | YouTube + X | 100K-180K | Every engineering manager just perked up. Jira + AI + automation = triple keyword hit. |
| 11 | "Open Source Tool Runs Claude Code, Codex, and Aider in Parallel" | Show HN post | HN | 80K-150K | Agent-agnostic is the differentiator. HN loves tools that don't lock you in. |
| 12 | "The 8-Plugin Architecture That Makes Agent Orchestrator Unkillable" | Technical blog | HN + blog | 60K-120K | Developers respect clean architecture. Plugin slots = extensibility = contributions = community. |
| 13 | "I Replaced My Sprint Planning With a YAML File" | Short-form video (90s) | X, YT Shorts | 80K-150K | Provocative. Shows the Jira auto-spawn config. Developers who hate meetings will share this reflexively. |
| 14 | "Watch: 5 AI Agents Race to Fix the Same Bug (Different Approaches)" | 6-min edited video | YouTube | 70K-130K | Competition format. Agent-agnostic means you can pit Claude Code vs Aider vs Codex. Entertainment + education. |
| 15 | "The CI Failure Auto-Fix Loop Nobody Knows About" | Thread (6 tweets) with GIF | X | 60K-100K | Specific, technical, immediately useful. CI failures are universal pain. Auto-fix is magic. |

### Tier C -- Community Builders (20K-60K reach, high conversion)

| # | Title | Format | Platform | Est. Reach | Why It Works |
|---|-------|--------|----------|------------|--------------|
| 16 | "From 0 to 30 Parallel Agents: My Setup Guide (15 min)" | Tutorial video | YouTube | 40K-80K | Evergreen search traffic. "How to run multiple AI agents" is a growing search query. |
| 17 | "Building a Discord Notifier Plugin for Agent Orchestrator (Live)" | Livestream | YouTube/Twitch | 30K-60K | Shows how easy the plugin system is. Encourages contributions. Live = engagement. |
| 18 | "Agent Orchestrator vs dmux vs Vibe Kanban -- Honest Comparison" | 15-min video | YouTube | 30K-60K | Comparison videos have incredible search longevity. Honest = trustworthy = subscribers. |
| 19 | "I Added Cost Tracking to My AI Agent Fleet -- The Numbers Shocked Me" | Thread + screenshot | X | 40K-70K | Money content always performs. Actual dollar figures create urgency and shareability. |
| 20 | "Contributing Your First Plugin to Agent Orchestrator (Beginner)" | 20-min tutorial | YouTube | 20K-40K | Community growth. Converts viewers into contributors. The plugin pattern is genuinely elegant for a tutorial. |

---

## 2. THE Viral Hook

**The one demo: You are on a train. Your phone buzzes -- Telegram notification from your AI agent: "CI failing on auth_test.py, tried 2 fixes, need guidance." You type back "skip it, it's flaky, focus on the API endpoint." You put your phone away. Ten minutes later: "PR #287 ready. All checks green." You tap the PR link, hit approve, merge from your phone. Done.**

Why this is THE hook:

1. **It inverts expectations.** People expect AI agent management to require a terminal, an IDE, a desk. Showing it on a phone on public transit is cognitive dissonance -- the brain stops to resolve it.
2. **It's immediately believable.** No fancy editing, no fake demos. A phone screen recording is inherently authentic.
3. **It triggers FOMO.** The viewer thinks: "Wait, this person is getting work done on a train while I'm sitting at my desk babysitting terminals?"
4. **The narrative arc is complete in 60 seconds.** Problem (CI failure) -> human judgment (skip it) -> resolution (PR merged). Beginning, middle, end. No prior context needed.
5. **It sells the "push not pull" philosophy** without ever saying those words.

**How to capture it:**
- Use iOS/Android screen recording
- Have a real AO instance running with Telegram configured
- Trigger a genuine CI failure (break a test intentionally)
- Record the full loop: notification -> reply -> resolution
- Add subtle captions but NO editing, NO music, NO transitions
- The rawness IS the point

**Thumbnail for YouTube:** Split screen -- left side: developer on subway looking at phone. Right side: terminal showing 10 agents running. Text overlay: "I manage 30 AI agents from Telegram."

---

## 3. Twitter/X Content Strategy

### Posting Cadence

| Day | Content Type | Time (ET) |
|-----|-------------|-----------|
| Monday | Build-in-public update (what shipped last week) | 9:00 AM |
| Tuesday | Technical insight or hot take | 12:30 PM |
| Wednesday | Demo video (30-90 seconds) | 10:00 AM |
| Thursday | Engagement post (question or poll) | 1:00 PM |
| Friday | Meme or lightweight content | 11:00 AM |
| Saturday | Thread (deep dive on architecture or workflow) | 10:00 AM |
| Sunday | Off or retweet/engage only | -- |

**Minimum 5 posts/week. Target 7-10 including replies and quote tweets.**

### Format Mix

- **Single tweet with media (40%)** -- screenshots, GIFs, phone recordings. Media posts get 2-3x engagement.
- **Threads (20%)** -- architecture deep-dives, workflow walkthroughs, build-in-public recaps. Threads get bookmarked and shared.
- **Video tweets (20%)** -- 30-90 second demos. Native video outperforms YouTube links 5:1 on X.
- **Text-only hot takes (15%)** -- opinions about AI coding, developer workflows, tool choices. Drives replies.
- **Polls (5%)** -- "How many AI agents do you run in parallel?" drives engagement and gives you data.

### 10 Example Tweets (Word for Word)

**Tweet 1 -- The Hook (video tweet)**
```
i manage 30 AI coding agents from telegram

they notify me when they need help.
i reply from my phone.
they keep going.

this is agent orchestrator. it's open source.

[60-second phone screen recording]
```

**Tweet 2 -- The Hot Take**
```
hot take: if you're running more than 3 AI agents and still switching between terminal tabs to check on them, you're doing it wrong

there's a tool for that. it's called an orchestrator.
```

**Tweet 3 -- The Build-in-Public Update**
```
shipped this week on agent orchestrator:

- telegram bidirectional messaging (reply to your agents from your phone)
- jira auto-spawn (new sprint ticket = new agent session)
- per-session FIFO message queue with file locking

47 tests added. 0 broken.

the "conversational orchestrator" pattern is real now.
```

**Tweet 4 -- The Provocation**
```
cursor: $20/mo, runs 1 agent at a time, locked to their IDE
agent orchestrator: free, runs 30 agents, works with any AI tool, notifies you on telegram

one of these has a $29B valuation.
the other has a yaml file.
```

**Tweet 5 -- The Relatable Pain**
```
me before agent orchestrator:
- open 8 terminals
- check each one every 5 minutes
- forget which one is working on what
- miss a CI failure for 30 minutes

me after:
- spawn 8 agents
- close laptop
- get telegram message when something needs me

this is what "push not pull" means
```

**Tweet 6 -- The Technical Thread (first tweet)**
```
how do you route a telegram message to the right AI agent session when you have 30 running?

a thread on the inbound context system we built for agent orchestrator:

[1/8]
```

**Tweet 7 -- The Screenshot**
```
my jira board at 9am vs 5pm

the AI agents started 12 tickets this morning. 9 PRs merged. 2 need my review. 1 is stuck on a flaky test.

i wrote 0 lines of code today and my sprint is ahead of schedule.

[before/after jira screenshot]
```

**Tweet 8 -- The Question**
```
genuine question for people running AI coding agents:

how do you handle it when an agent needs human input mid-task?

do you:
- check terminals manually
- just... hope it figures it out
- use notifications somehow

because we built something for this
```

**Tweet 9 -- The Meme Format**
```
developer: "i'm a 10x engineer"

agent orchestrator user running 30 parallel agents: "that's cute"

[image: galaxy brain meme with escalating levels from "write code" to "tell AI to write code" to "tell 30 AIs to write code" to "manage 30 AIs from telegram while on the subway"]
```

**Tweet 10 -- The Launch Announcement**
```
agent orchestrator just hit [milestone].

open source. mit license.

what it does:
- spawn AI agents (claude code, codex, aider) in parallel
- auto-assign from github/jira/linear
- auto-fix CI failures
- notify you on telegram/slack when they need you
- you reply. they continue.

no vendor lock-in. no subscription. just a yaml file and vibes.

github.com/[repo]
```

---

## 4. YouTube Strategy

### Short-Form vs Long-Form: Do Both, Weight Toward Shorts

**The Algorithm Reality in 2026:**
- YouTube Shorts (under 60s) get 3-10x the impressions of long-form for new channels
- But long-form builds subscribers and watch time (which drives suggestions)
- The winning strategy: Shorts for discovery, long-form for conversion

### Content Split

| Format | Length | Frequency | Purpose |
|--------|--------|-----------|---------|
| YouTube Shorts | 30-60s | 3/week | Discovery, viral reach, algorithm training |
| Mid-form demos | 5-8 min | 1/week | "Here's how it works" -- the conversion piece |
| Long-form tutorials | 15-25 min | 2/month | Evergreen search traffic, deep credibility |
| Livestreams | 1-3 hours | 2/month | Community building, live agent demos |

### What Gets Suggested by the Algorithm

YouTube suggests videos that:
1. **Have high click-through rate (CTR)** -- thumbnails with split screens, before/after, numbers ("30 agents"), faces showing surprise
2. **Retain viewers past 30 seconds** -- open with the result, then show the how
3. **Drive session time** -- end each video with a teaser for the next one
4. **Match trending search queries** -- "AI coding agents", "Claude Code tutorial", "Aider setup", "parallel AI agents"

### Specific Thumbnail Formulas

- **The Split Screen:** Left = messy terminal chaos. Right = clean dashboard with green checkmarks. Text: "Before / After Agent Orchestrator"
- **The Number:** Giant "30" in bold. Subtext: "AI agents, 1 human, 0 stress." Your face looking shocked.
- **The Phone:** Photo of phone showing Telegram conversation with an AI agent. Text: "My AI Agents Text Me Now"
- **The Jira Board:** Screenshot of a Jira board going from "full" to "empty." Text: "AI Cleared My Sprint"

### Series Ideas

1. **"Fleet Week"** -- 5 daily videos of running 30 agents on a real project. Day 1: setup. Day 2: first spawn. Day 3: first failures. Day 4: optimization. Day 5: results.
2. **"Agent Battle Royale"** -- Claude Code vs Codex vs Aider on the same task, all managed by AO. Weekly.
3. **"Build the Plugin"** -- Build a new AO plugin from scratch in each episode. Teaches the architecture while producing content.

---

## 5. Build-in-Public Playbook

### What to Share

| Share This | Why | Format |
|-----------|-----|--------|
| Star count milestones (every 1K) | Social proof, creates FOMO | Single tweet with graph |
| Weekly ship log (features + tests) | Shows velocity, builds trust | Thread or changelog post |
| Architecture decisions and tradeoffs | Developers respect transparency | Blog or thread |
| Bug discoveries and fixes | Humanizes the project, shows quality | Tweet with code snippet |
| Contributor PRs and shoutouts | Encourages more contributions | Quote tweet with praise |
| User feedback (positive AND constructive) | Shows real adoption | Screenshot tweet |
| Performance numbers (agents spawned, PRs merged) | Concrete proof it works | Infographic tweet |
| Honest comparisons with competitors | Builds credibility | Thread |

### What NOT to Share

| Avoid This | Why |
|-----------|-----|
| Internal drama or frustration with contributors | Toxic, drives people away |
| Revenue/business model speculation before product-market fit | Premature, invites criticism |
| Roadmap items you're not confident about | Creates expectations you can't meet |
| Security vulnerabilities before they're patched | Obvious |
| Metrics that show declining growth | Share only upward trends or be silent |
| Complaints about competitors | Looks petty, always let the product speak |

### How to Make Progress Interesting

The secret: **every technical decision is a story if you frame it right.**

Bad: "Added file locking to inbound context store"
Good: "When two Telegram messages arrive at the same millisecond for the same agent session, which one wins? We built a FIFO queue with atomic file locking. Here's why we chose files over Redis for this..."

Bad: "Implemented Jira auto-spawn"
Good: "What if your Jira board could spawn AI agents automatically? New ticket in sprint = new agent working on it. No human intervention. Here's the 50 lines of YAML that make it happen."

**The formula: Problem (relatable) -> Decision (interesting) -> Implementation (brief) -> Result (impressive)**

---

## 6. Influencer Strategy

### 10 Specific Dev Influencers to Target

| # | Person | Platform | Followers | Why Them | Approach |
|---|--------|----------|-----------|----------|----------|
| 1 | **Theo Browne** (@theo / t3.gg) | YouTube/X | 500K+ YT | Covers dev tools obsessively, loves hot takes, massive reach | Send a DM with the Telegram demo video. One line: "What if you could manage AI agents from Telegram?" He'll want to react to it. |
| 2 | **Fireship** (Jeff Delaney) | YouTube | 3M+ YT | "100 seconds of X" format is perfect for AO. Massive dev audience. | Pitch a "100 seconds of Agent Orchestrator" segment. Provide a clean 60s demo he can narrate over. |
| 3 | **Matt Pocock** (@maaboroshi) | X/YouTube | 200K+ X | TypeScript educator, would appreciate the clean TS architecture. | DM highlighting the plugin pattern with `satisfies PluginModule<T>`. He'll geek out on the type safety angle. |
| 4 | **Devin / Cognition Labs** (@cognaborative) | X | 300K+ X | Competitive mention. Devin content always goes viral. | Don't approach directly. Create comparison content ("AO vs Devin: Open Source vs Black Box"). They may respond, driving engagement. |
| 5 | **ThePrimeagen** | YouTube/X | 800K+ YT | CLI-first, tmux power user, loves open source, hates vendor lock-in. AO is his dream tool. | Post a clip of AO running in tmux with 10 agents. Tag him. He uses tmux daily -- this is catnip. |
| 6 | **Wes Bos** (@wesbos) | X/YouTube | 400K+ X | Covers developer tools, has podcast (Syntax). Practical, not hype-driven. | Email via his Syntax podcast contact. Pitch a 5-minute segment: "This open source tool runs 30 AI agents in parallel." |
| 7 | **Simon Willison** (@simonw) | X/Blog | 100K+ X | Thoughtful AI tools coverage. HN-respected voice. If he blogs about AO, HN will follow. | File an issue on his TIL repo or reply to one of his threads about AI agents with the AO demo. He discovers tools organically. |
| 8 | **Josh W Comeau** (@JoshWComeau) | X/Blog | 150K+ X | Makes complex concepts accessible. Could cover the plugin architecture beautifully. | Share the architecture diagram. He loves visual explanations of systems design. |
| 9 | **Cassidy Williams** (@cassidoo) | X/Newsletter | 250K+ X | Weekly newsletter reaches devs. Covers interesting tools. | Submit AO to her "cool things" newsletter section with the Telegram angle. Short, punchy description. |
| 10 | **Paul Copplestone** (@kiwicopple) | X | 80K+ X | Supabase CEO, open source advocate, regularly amplifies good OSS projects. | Tag him in a build-in-public thread about AO's growth. He loves underdog OSS stories. |

### Approach Playbook

**Rule 1: Never cold-pitch. Always lead with value.**
- Wrong: "Hey, can you cover our tool?"
- Right: "Made this 60s demo of managing AI agents from Telegram. Thought you'd find it interesting." [attach video, no ask]

**Rule 2: Make it easy to share.**
- Provide a 60-second clip they can repost with zero effort
- Write a one-line description they can copy
- Never send a press release or feature list

**Rule 3: Create reasons for them to discover you organically.**
- Reply to their tweets about AI agents with genuine insights (not plugs)
- Be active in their communities
- Build something that extends THEIR tool (e.g., a plugin for their project)

---

## 7. The Hacker News Post

### Title

```
Show HN: Agent Orchestrator -- Manage 30 parallel AI agents from Telegram
```

(Alternative if Telegram angle doesn't resonate: `Show HN: Agent Orchestrator -- Spawn AI agents from your issue tracker, get notified when they need you`)

### Body

```
Hi HN,

I've been running 5-10 AI coding agents in parallel for a few months (Claude Code, Aider,
Codex) and the workflow was terrible. Eight tmux panes. Constant tab-switching. Missing CI
failures for 30 minutes because I forgot to check. Agents stuck waiting for input I didn't
know they needed.

So I built Agent Orchestrator -- an open-source lifecycle manager for parallel AI coding agents.

What it does:

- Spawns agents from your issue tracker (GitHub Issues, Jira, Linear). New ticket = new
  agent session in an isolated worktree.
- Monitors CI. If a build fails, it sends the failure back to the agent automatically.
  The agent tries to fix it. If it can't after N attempts, it notifies you.
- Routes review comments back to agents. Reviewer says "rename this variable" -- the agent
  handles it without you.
- Notifies you via Telegram/Slack/desktop ONLY when human judgment is needed. Push, not pull.
- You can reply to agents from Telegram. Message routes to the right session. Agent continues.

The "reply from Telegram" part is what made this click for me. I was on the subway, got a
notification that an agent was stuck on a flaky test, replied "skip it, focus on the API
endpoint", and 10 minutes later had a merged PR. Never opened my laptop.

Architecture: 8 swappable plugin slots (runtime, agent, workspace, tracker, SCM, notifier,
terminal, lifecycle). Currently ships with tmux runtime, 4 agent adapters (Claude Code,
Codex, Aider, OpenCode), GitHub/Jira/Linear trackers, and 5 notifier channels.

The inbound message routing was the hard part -- per-session FIFO queue with atomic file
locking, Telegram message deduplication by chatId:messageId, session routing via markers
in reply chains. Happy to go deep on this if anyone's interested.

Stack: TypeScript (ESM), Node 20+, pnpm workspaces, Next.js 15 dashboard, Commander.js CLI.

MIT licensed. No telemetry. No cloud dependency. Just a YAML config and your agents.

Repo: [link]
Demo video (60s, shows the Telegram flow): [link]

Would love feedback on the architecture -- especially the plugin system. We're trying to make
it easy for anyone to add new agent backends or trackers without touching core.
```

### Why This Post Works for HN

1. **Starts with personal pain** -- HN respects "I had this problem" over "we built a product."
2. **Technical depth** -- mentions FIFO queues, file locking, deduplication. HN readers want to know it's not a toy.
3. **Architecture section** -- 8 plugin slots invites discussion. HN loves debating architecture.
4. **Honest scope** -- "MIT licensed. No telemetry. No cloud dependency." This is HN-speak for "we're not trying to sell you anything."
5. **Explicit ask for feedback** -- encourages comments, which drives ranking.
6. **No buzzwords** -- no "revolutionary," no "game-changing," no "AI-powered." Just what it does.

---

## 8. Meme Potential

**Yes, this tool can absolutely be memed.** The core concept -- one human managing a fleet of AI agents -- is inherently absurd and funny.

### Meme Formats That Work

**1. The Galaxy Brain / Escalation Meme**
```
Level 1: Writing code yourself
Level 2: Using an AI to write code
Level 3: Using 5 AIs to write code in parallel
Level 4: Managing 30 AIs from Telegram while on the subway
Level 5: Your AI agents arguing with each other in your Jira comments
```

**2. The "They Don't Know" Party Meme**
```
[Person standing alone at party]
"They don't know I have 30 AI agents working on my sprint right now"
```

**3. The Drake Format**
```
Drake no: Checking 8 terminal tabs every 5 minutes
Drake yes: Getting a Telegram message saying "PR merged, all checks green"
```

**4. The Distracted Boyfriend**
```
Boyfriend: Developer
Girlfriend: Actually writing code
Other woman: Managing 30 AI agents from your phone
```

**5. The "Is This" Butterfly Meme**
```
Person: Me at my desk with 30 agents running
Butterfly: A single Telegram notification
"Is this... 10x engineering?"
```

**6. The Two Buttons Sweat Meme**
```
Button 1: Manually check 30 terminal tabs
Button 2: Get a Telegram ping only when something needs you
[Sweating guy labeled "developers who haven't found agent orchestrator"]
```

**7. Original Format -- "Agent Orchestrator Status Board"**
Create a recurring meme format: a fake dashboard showing absurd agent statuses.
```
Agent 1: Writing auth middleware          [DONE]
Agent 2: Fixing CSS                       [STUCK - 47th attempt]
Agent 3: Refactoring database layer       [DONE]
Agent 4: Adding dark mode                 [GONE ROGUE - ADDING LIGHT MODE]
Agent 5: Resolving merge conflicts        [HAVING EXISTENTIAL CRISIS]
```
This format is infinitely repeatable and community-contributed.

### Meme Distribution Strategy
- Post memes on Friday (lighter content day)
- Create a #memes channel in Discord
- Encourage community submissions
- Use memes as replies to competitor announcements (tastefully)
- The "status board" format should become an AO community signature

---

## 9. Live Streaming Strategy

### "30 Agents Live" -- Yes, This Would Work

**The concept:** Stream a 2-3 hour session where you spawn 30 agents from a real Jira board and manage them live. Viewers watch agents work in real time. You interact only when notified.

**Why it works:**
- **Spectacle factor.** Nobody has done this. 30 terminals working simultaneously is visually hypnotic.
- **Unpredictability.** Live = things will go wrong. That's content. Agent fails, CI breaks, merge conflict -- handling it live is compelling.
- **Audience participation.** "Chat, should I approve this PR or ask the agent to refactor?" Involvement = retention.
- **Proof of concept.** No amount of marketing equals watching it work in real time for 2 hours.

### Stream Format

```
0:00-0:10  Setup and explanation (YAML config walkthrough, dashboard tour)
0:10-0:15  Batch-spawn 30 agents from Jira sprint board
0:15-1:30  "The Waiting Game" -- agents work, streamer chills, responds to Telegram
           notifications live, reviews PRs, handles CI failures
           Overlay: dashboard showing live session status
           Phone on camera showing Telegram notifications in real time
1:30-1:45  Mid-stream recap (how many PRs merged, how many stuck, costs so far)
1:45-2:30  Continue + handle the hard cases (agents that failed, need human input)
2:30-2:45  Final tally: PRs merged, tests passing, total cost, time saved
2:45-3:00  Q&A with chat
```

### Technical Setup for Streaming

- OBS with 4 scenes: dashboard (main), terminal grid (detail), phone camera (Telegram), face cam
- Dashboard scene shows the web UI with session cards updating in real time via SSE
- Terminal scene shows a tmux grid with 6-8 agent sessions visible
- Phone camera (cheap phone mount) shows Telegram notifications arriving
- Cost counter overlay (when cost tracking ships)

### Platform Choice

- **YouTube Live** over Twitch. Reason: YouTube archives are searchable and suggested. Twitch VODs die. The recording of this stream will generate views for months.
- **Cross-stream to X** using restream.io for discoverability.
- **Create 10-15 YouTube Shorts** from highlights after the stream.

### Cadence

- Monthly "Fleet Friday" livestream (first Friday of each month)
- Each month, increase scale or try a new angle:
  - Month 1: 10 agents, simple tasks
  - Month 2: 30 agents, full Jira sprint
  - Month 3: Mixed agents (Claude Code + Aider + Codex)
  - Month 4: Community challenges ("chat picks the issues")
  - Month 5: Overnight stream (agents work while streamer sleeps)

---

## 10. Content Repurposing: 1 Demo -> 10 Pieces

**Source material:** One 2-hour livestream of spawning 30 agents from Jira.

| # | Derivative Content | Platform | Effort | Timeline |
|---|-------------------|----------|--------|----------|
| 1 | Full livestream archive | YouTube | Zero (already recorded) | Same day |
| 2 | 8-minute highlight reel ("30 Agents, 30 PRs -- Full Recap") | YouTube | 2 hours editing | Day 1 |
| 3 | 60-second "best moment" Short (the subway Telegram reply) | YT Shorts, X, TikTok | 30 min | Day 1 |
| 4 | 30-second "spawn moment" Short (the batch-spawn command) | YT Shorts, X, TikTok | 15 min | Day 1 |
| 5 | Twitter thread: "I just ran 30 AI agents live for 2 hours. Here's what happened." (8 tweets with screenshots) | X | 45 min | Day 2 |
| 6 | Blog post: "Lessons From Running 30 AI Agents on a Live Stream" | dev.to, HN | 2 hours | Day 3 |
| 7 | Reddit post to r/ClaudeAI: "Ran 30 Claude Code agents in parallel -- here are the results" | Reddit | 30 min | Day 4 |
| 8 | Reddit post to r/ExperiencedDevs: "Using AI agent orchestration to clear a sprint board" | Reddit | 30 min | Day 4 |
| 9 | Newsletter/Discord recap with stats and learnings | Email/Discord | 30 min | Day 5 |
| 10 | Audiogram/podcast clip if you do any voiceover commentary | X, LinkedIn | 1 hour | Day 6 |

**Bonus derivatives:**
- Pull 3-5 funny/interesting moments as standalone GIFs for future tweet replies
- Screenshot the final dashboard state as a reusable "proof" image
- Extract the YAML config shown on stream as a GitHub Gist (educational content)

**The multiplier math:** 2 hours of streaming effort becomes 10+ pieces over 6 days, reaching 5 different platforms, with a combined potential reach of 200K-500K. That is the content engine.

---

## 11. What Content DOESN'T Work (Avoid These)

### Hard No's

| Content Type | Why It Fails | Example to Avoid |
|-------------|-------------|-----------------|
| **Feature announcement threads with no demo** | "We shipped X" without showing it means nothing. Words are not proof. | "Excited to announce our new Jira integration! [link]" |
| **"Awesome list" style roundup posts** | Positions you as a curator, not a builder. Zero differentiation. | "Top 10 AI Agent Tools in 2026" |
| **Overly produced marketing videos** | Developers smell marketing from a mile away. Polish = distrust. | Animated explainer with stock music and motion graphics |
| **Generic thought leadership** | "The future of AI coding" posts are noise. Everyone writes them. | "5 Ways AI Will Change Software Development" |
| **LinkedIn-style posts** | LinkedIn's dev audience is shallow. Engagement doesn't convert to stars. | Any post starting with "I'm thrilled to announce..." |
| **Product Hunt launches** | Declining platform. Non-dev audience. Low conversion (0.5-1%). Time wasted. | A full Product Hunt campaign with hunter, tagline, etc. |
| **Paid influencer posts** | Obvious, damages credibility, expensive, low conversion for dev tools. | Paying someone $5K to tweet about AO |
| **Posts that trash competitors by name** | Makes you look insecure. Let the product speak. Comparison is fine; insults are not. | "Devin is a scam, use Agent Orchestrator instead" |
| **Tutorial content before you have users** | Nobody searches for "agent orchestrator tutorial" when they don't know it exists. Do discovery content first. | "Complete Agent Orchestrator Setup Guide" as your first video |
| **Content that requires context** | If someone needs to know what AO is before your content makes sense, you've lost 90% of the audience. | "New in AO v0.4: reaction system improvements" |

### Specific Anti-Patterns

1. **The changelog dump.** Nobody cares about your changelog unless they're already a user. Wrap it in a story.
2. **The technical flex with no payoff.** "We use atomic file locking with FIFO queues" means nothing without "so your Telegram replies always reach the right agent."
3. **The premature enterprise pitch.** Don't talk about teams, RBAC, or enterprise features until you own the individual developer. You're not there yet.
4. **Engagement bait without substance.** "What's the best AI coding tool? Wrong answers only" gets likes but zero stars.

---

## 12. Twelve-Month Content Calendar

### Month 1 (March 2026): "The Launch"

**Theme:** Introduce the tool. Establish the Telegram hook.

| Week | Content | Platform |
|------|---------|----------|
| W1 | Record THE demo (Telegram subway loop). Polish README with GIF. | Production |
| W2 | Show HN post. Simultaneously: demo video tweet, r/programming post, r/ClaudeAI post. | HN, X, Reddit |
| W3 | "I Manage 30 AI Agents From Telegram" blog post. Thread version on X. | dev.to, X |
| W4 | First "Fleet Friday" livestream (10 agents, keep it manageable). Create Discord. | YouTube Live, Discord |

**Star target:** 3,800 -> 8,000

### Month 2 (April 2026): "The Architecture"

**Theme:** Earn technical credibility. Show this isn't a toy.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "The 8-Plugin Architecture" technical blog post. Submit to HN. | HN, blog |
| W2 | "Building a Custom Plugin" tutorial video. | YouTube |
| W3 | "Agent Battle: Claude Code vs Aider vs Codex" comparison video. | YouTube, X clips |
| W4 | Fleet Friday #2 (30 agents, full Jira sprint). | YouTube Live |

**Star target:** 8,000 -> 12,000

### Month 3 (May 2026): "The Workflow"

**Theme:** Show real workflows, not just features. Make it practical.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "I Replaced Sprint Planning With a YAML File" video. | YouTube, X |
| W2 | "The CI Auto-Fix Loop" deep dive thread. | X |
| W3 | "From Issue to Merged PR in 8 Minutes" speed demo. | YouTube Short, X |
| W4 | Fleet Friday #3 (mixed agents). First contributor spotlight. | YouTube Live, X |

**Star target:** 12,000 -> 15,000

### Month 4 (June 2026): "The Community"

**Theme:** Shift from "my tool" to "our tool." Drive contributions.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "Contributing Your First Plugin" tutorial. Tag easy first issues. | YouTube, GitHub |
| W2 | Community plugin showcase (highlight external contributors). | X thread, Discord |
| W3 | "Why We Chose MIT License" values post. | Blog, X |
| W4 | Fleet Friday #4 (community challenges -- viewers pick the issues). | YouTube Live |

**Star target:** 15,000 -> 18,000

### Month 5 (July 2026): "The Comparison"

**Theme:** Position against alternatives. Own the narrative.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "Agent Orchestrator vs dmux vs Vibe Kanban" honest comparison video. | YouTube |
| W2 | "Why I Stopped Using Cursor for Multi-File Changes" (position AO as complement). | YouTube, X |
| W3 | Comparison page on the website. Submit to HN as "Agent Orchestration landscape." | Website, HN |
| W4 | Fleet Friday #5 (overnight stream -- agents work while you sleep). | YouTube Live |

**Star target:** 18,000 -> 22,000

### Month 6 (August 2026): "The Scale Story"

**Theme:** Push the scale narrative. Bigger numbers = bigger attention.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "100 Agent Sessions in One Day: What I Learned" data-heavy post. | Blog, HN |
| W2 | Cost breakdown video: "How much does it cost to run 30 AI agents?" | YouTube, X |
| W3 | "The Push Not Pull Manifesto" -- category-defining essay. | Blog, HN |
| W4 | Fleet Friday #6 (attempt a 50-agent run). | YouTube Live |

**Star target:** 22,000 -> 26,000

### Month 7 (September 2026): "The Conference Circuit"

**Theme:** Go beyond the internet. Physical presence.

| Week | Content | Platform |
|------|---------|----------|
| W1 | Prepare conference talk: "Orchestrating AI Agent Fleets." Submit to 5 CFPs. | Offline |
| W2 | "I Gave a Talk About AI Agent Orchestration" behind-the-scenes content. | X, YouTube |
| W3 | Local meetup demo -- record it, post it. | YouTube, X |
| W4 | Fleet Friday #7. Interview a community contributor on stream. | YouTube Live |

**Star target:** 26,000 -> 29,000

### Month 8 (October 2026): "The Team Play"

**Theme:** Introduce team features. Expand the audience.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "Agent Orchestrator for Teams: What Changes" announcement post. | Blog, X |
| W2 | Demo: multi-user dashboard, shared notifications, team visibility. | YouTube |
| W3 | "How Our Engineering Team Runs 50 Agents in Parallel" (case study, even if internal). | Blog, HN |
| W4 | Fleet Friday #8 (team demo -- 3 people managing agents simultaneously). | YouTube Live |

**Star target:** 29,000 -> 33,000

### Month 9 (November 2026): "The Docker Play"

**Theme:** Docker runtime launch. Reach the DevOps crowd.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "Agent Orchestrator Now Runs in Docker" launch post. | Blog, X, HN |
| W2 | "Docker vs tmux for AI Agents: When to Use What" comparison. | YouTube |
| W3 | Docker Compose example repo. Submit to awesome-docker. | GitHub, X |
| W4 | Fleet Friday #9 (all agents in Docker containers). | YouTube Live |

**Star target:** 33,000 -> 37,000

### Month 10 (December 2026): "The Year in Review"

**Theme:** Retrospective content. Capitalize on end-of-year lists.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "2026: The Year AI Agents Went Parallel" year-in-review post. | Blog, HN |
| W2 | "Agent Orchestrator: 3,800 to [X] Stars -- What Worked" build-in-public retrospective. | X thread, YouTube |
| W3 | "Top 10 Open Source Finds of 2026" -- pitch AO to list makers. | Outreach |
| W4 | Holiday break. Queue up evergreen content. | Scheduled posts |

**Star target:** 37,000 -> 40,000

### Month 11 (January 2027): "The Ecosystem"

**Theme:** Third-party plugins, integrations, community ecosystem.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "The AO Plugin Ecosystem: 20+ Plugins and Counting" showcase. | Blog, X |
| W2 | "Build an Agent Orchestrator Plugin in 30 Minutes" hackathon-style stream. | YouTube Live |
| W3 | GitLab SCM plugin launch. Reach the GitLab community. | Blog, X, GitLab forums |
| W4 | Fleet Friday #11 (community plugins in action). | YouTube Live |

**Star target:** 40,000 -> 44,000

### Month 12 (February 2027): "The Endgame"

**Theme:** Cloud announcement teaser. Push toward 50K.

| Week | Content | Platform |
|------|---------|----------|
| W1 | "What We Learned Managing 100,000 AI Agent Sessions" data post. | Blog, HN |
| W2 | Cloud beta announcement teaser. Waitlist. | X, Blog, YouTube |
| W3 | "Agent Orchestrator: The Movie" -- 10-minute cinematic recap of the journey. | YouTube |
| W4 | 50K star celebration (if reached). Community thank-you. Plan for the next year. | X, YouTube, Discord |

**Star target:** 44,000 -> 50,000

---

## Final Notes

### The Content Engine Flywheel

```
Demo video -> Twitter virality -> HN post -> GitHub stars ->
Contributors -> More features -> More demos -> More virality
```

Each piece of content feeds the next. The livestreams generate clips. The clips drive Twitter. Twitter drives HN. HN drives stars. Stars drive contributors. Contributors ship features. Features become new demos. This is a flywheel, not a campaign.

### The One Thing That Matters Most

If you do NOTHING else from this document, do this:

**Record a 60-second phone screen recording of the Telegram flow -- notification arrives, you reply, agent continues, PR merges -- and post it on Twitter with the caption "i manage 30 AI coding agents from telegram." That single piece of content, if the product works as shown, will generate more stars than everything else combined.**

The tool is ready. The content engine is designed. Now execute.
