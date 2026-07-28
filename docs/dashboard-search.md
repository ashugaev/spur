# Dashboard search

Dashboard search uses case-insensitive substring matching.

Session matches:

- session ID
- title
- project name
- branch
- canonical user task
- visible GitHub pull request (`#123`), GitLab merge request (`!123`), and Jira-style tracker (`PROJ-123`) identifiers

A matched session shows its full desk. Runtime prompt instructions, generated bootstrap prompts, link URLs, link labels, and unrecognized work-item links are excluded.

Available backlog rows match their key, title, or project ID.
