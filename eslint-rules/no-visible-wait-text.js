const WAIT_TEXT =
  /^(?:Loading(?:\.{3}|…)|Loading preview|Please wait|(?:Creating|Deleting|Saving|Spawning|Respawning|Queueing|Sending|Inserting|Switching|Adding|Answering|Copying|Handing off|Pausing|Restoring|Reopening|Completing|Killing|Clearing|Starting|Transcribing)(?:\s[^\n]*)?(?:\.{3}|…))$/i;

function literalText(node) {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("placeholder");
  }
  return null;
}

function reportWaitText(context, node, value) {
  if (value && WAIT_TEXT.test(value.trim())) {
    context.report({ node, messageId: "replaceWithMotion" });
  }
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
        reportWaitText(context, node, literalText(node));
      },
      TemplateLiteral(node) {
        reportWaitText(context, node, literalText(node));
      },
      JSXText(node) {
        reportWaitText(context, node, node.value);
      },
    };
  },
};

export const visibleWaitTextPlugin = {
  rules: { "no-visible-wait-text": noVisibleWaitText },
};
