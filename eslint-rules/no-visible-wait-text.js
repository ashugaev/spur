const WAIT_TEXT =
  /^(?:Loading(?:\.{3}|…)|Loading preview|Please wait|(?:Creating|Deleting|Saving|Spawning|Respawning|Queueing|Sending|Inserting|Switching|Adding|Answering|Copying|Handing off|Pausing|Restoring|Reopening|Completing|Killing|Clearing)(?:\s[^\n]*)?(?:\.{3}|…))$/i;

function literalText(node) {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("placeholder");
  }
  return null;
}

export const noVisibleWaitText = {
  meta: {
    type: "problem",
    docs: { description: "ban visible static wait text in the web UI" },
    messages: { replaceWithMotion: "Replace visible wait text with motion-only feedback." },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        const value = literalText(node);
        if (value && WAIT_TEXT.test(value.trim())) {
          context.report({ node, messageId: "replaceWithMotion" });
        }
      },
      TemplateLiteral(node) {
        const value = literalText(node);
        if (value && WAIT_TEXT.test(value.trim())) {
          context.report({ node, messageId: "replaceWithMotion" });
        }
      },
    };
  },
};

export const visibleWaitTextPlugin = {
  rules: { "no-visible-wait-text": noVisibleWaitText },
};
