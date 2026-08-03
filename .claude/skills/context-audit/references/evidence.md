# Evidence

One line per claim: `claim | number | url`. No narrative.

Contradiction cost degrades output | prompt-optimization cookbook shrank a contradictory prompt 3626KB to 578KB, robustness rose 0.320 to 0.540 | https://developers.openai.com/cookbook/examples/gpt-5/prompt-optimization-cookbook
Contradiction cost, general guidance | GPT-5 prompting guide names conflicting instructions as a primary failure mode | https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide
Contradictory memory files degrade output | Claude "may pick one arbitrarily" when memory files conflict | https://code.claude.com/docs/en/memory
Tool-choice accuracy degrades past 30-50 tools | Anthropic states model accuracy falls once tool count passes this range | https://www.anthropic.com/engineering/advanced-tool-use
Tool-choice degradation, measured | Opus 4 accuracy 49% to 74% depending on tool count band | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
Tool-choice degradation, measured, newer model | Opus 4.5 accuracy 79.5% to 88.1% depending on tool count band | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
Tool-choice degradation, retrieval framing | RAG-MCP raises correct tool selection 13.62% to 43.13% | https://arxiv.org/abs/2505.03275
CLI over MCP, official guidance | Anthropic engineering post recommends code execution / CLI over per-call MCP tool listing | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
CLI over MCP, cost accounting | Anthropic cost doc states MCP tool definitions load every turn whether called or not | https://code.claude.com/docs/en/costs
CLI over MCP, benchmarked | Scalekit 75-run benchmark: CLI used 4x-32x fewer tokens, 25/25 vs 18/25 task success vs MCP | https://www.scalekit.com/blog/mcp-vs-cli-use
Skill size cap | Anthropic sets SKILL.md under 500 lines, references one level deep | https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
CLAUDE.md size guidance | Anthropic best-practices doc recommends a short, human-readable memory file | https://code.claude.com/docs/en/best-practices
Over-prompting removal improves output | Opus 5 prompting guide recommends deleting redundant emphasis and repeated instructions | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5
Prompting fundamentals, general | Anthropic prompt-engineering doc: be explicit, show don't tell, avoid filler | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
Persona preambles show no reliable accuracy effect | 162 role-prompts tested across tasks, no consistent gain | https://aclanthology.org/2024.findings-emnlp.888/
Instruction crowding degrades adherence | IFScale: adherence drops as instruction count in one prompt rises | https://arxiv.org/html/2507.11538v1
Long-context degradation, position effect | Lost in the Middle: retrieval accuracy drops for context placed mid-document | https://arxiv.org/abs/2307.03172
Long-context degradation, semantic drift | Context rot: retrieval and reasoning accuracy fall as input length grows even within stated context limits | https://arxiv.org/abs/2510.05381
Context rot, applied measurement | Chroma research shows accuracy decline with growing context on 18 models | https://research.trychroma.com/context-rot
Tool surface bloat, applied case | GPT-5 cookbook example shows agent picking wrong tool among near-duplicate schemas | https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide

DO NOT CITE, checked and rejected this pass:
Anthropic's 98.7% code-execution-with-MCP figure — a worked example, not an experiment.
Cloudflare's 99.9% context-reduction figure — vendor claim, no reproducible method found.
"68% of enterprise prompts are bloated" — no traceable primary source.
Politeness or filler phrasing changing accuracy — contested by two opposing studies, no stable effect size.
