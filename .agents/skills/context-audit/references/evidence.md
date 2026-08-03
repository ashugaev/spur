EVIDENCE

One claim per block: claim, then number, then url. No narrative.


CONTRADICTION COST

  Contradictory prompt shrank 3626KB to 578KB, robustness 0.320 to 0.540
  https://developers.openai.com/cookbook/examples/gpt-5/prompt-optimization-cookbook

  GPT-5 guide names conflicting instructions a primary failure mode
  https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide

  Claude "may pick one arbitrarily" when memory files conflict
  https://code.claude.com/docs/en/memory


TOOL-CHOICE DEGRADATION

  Accuracy falls once tool count passes 30-50
  https://www.anthropic.com/engineering/advanced-tool-use

  Opus 4 accuracy 49% to 74% across tool-count bands
  Opus 4.5 accuracy 79.5% to 88.1% across tool-count bands
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool

  RAG-MCP raises correct tool selection 13.62% to 43.13%
  https://arxiv.org/abs/2505.03275


CLI OVER MCP

  Anthropic recommends code execution and CLI over per-call tool listing
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

  MCP tool definitions load every turn whether called or not
  https://code.claude.com/docs/en/costs

  Scalekit 75 runs: CLI used 4x-32x fewer tokens, 25/25 vs 18/25 success
  https://www.scalekit.com/blog/mcp-vs-cli-use


SIZE AND OVER-PROMPTING

  SKILL.md under 500 lines, references one level deep
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices

  Short human-readable memory file recommended
  https://code.claude.com/docs/en/best-practices

  Opus 5 guide: delete redundant emphasis and repeated instructions
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5

  Be explicit, show don't tell, avoid filler
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices

  162 role-prompts tested, no consistent accuracy gain from a persona
  https://aclanthology.org/2024.findings-emnlp.888/


LENGTH AND POSITION

  IFScale: adherence drops as instruction count in one prompt rises
  https://arxiv.org/html/2507.11538v1

  Lost in the Middle: retrieval accuracy drops for mid-document context
  https://arxiv.org/abs/2307.03172

  Accuracy falls as input length grows even within stated context limits
  https://arxiv.org/abs/2510.05381

  Chroma measured accuracy decline with growing context on 18 models
  https://research.trychroma.com/context-rot


DO NOT CITE, checked and rejected this pass

  Anthropic 98.7% code-execution-with-MCP. Worked example, not an experiment.
  Cloudflare 99.9% context reduction. Vendor claim, no reproducible method.
  "68% of enterprise prompts are bloated". No traceable primary source.
  Politeness or filler changing accuracy. Two opposing studies, no stable effect.
