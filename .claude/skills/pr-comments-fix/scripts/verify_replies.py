import json
import sys

SPUR_FOOTER = "Written by Spur ·"

data = json.load(sys.stdin)
threads = data["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
issues = []
for t in threads:
    nodes = t["comments"]["nodes"]
    if not nodes:
        continue
    first = nodes[0]
    author = first.get("author") or {}
    has_reply = t["comments"]["totalCount"] > 1
    foreign_bot = author.get("__typename") == "Bot" and SPUR_FOOTER not in first["body"]
    unresolved_bot = foreign_bot and not t["isResolved"]
    if not has_reply or unresolved_bot:
        issues.append(
            {
                "thread_id": t["id"],
                "comment_id": first["databaseId"],
                "author": author.get("login", "unknown"),
                "has_reply": has_reply,
                "is_resolved": t["isResolved"],
                "body": first["body"][:80],
            }
        )

if issues:
    print(f"FAIL: {len(issues)} thread(s) need attention:")
    for i in issues:
        flags = []
        if not i["has_reply"]:
            flags.append("NO REPLY")
        if not i["is_resolved"] and i["has_reply"]:
            flags.append("NOT RESOLVED")
        print(f"  [{' | '.join(flags)}] comment_id={i['comment_id']} thread={i['thread_id']}")
        print(f"    @{i['author']}: {i['body']}")
    sys.exit(1)
print(f"OK: all {len(threads)} threads have replies; non-Spur bot threads are resolved.")
