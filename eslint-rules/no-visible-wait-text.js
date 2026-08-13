const WAIT_TEXT =
  /^(?:Loading(?:\s[^\n.…]+)?(?:\.{3}|…)?|Please wait(?:\.{3}|…)?|(?:Creating|Deleting|Saving|Spawning|Respawning|Queueing|Sending|Inserting|Switching|Adding|Answering|Copying|Handing off|Pausing|Restoring|Reopening|Completing|Killing|Clearing|Starting|Transcribing)(?:\s[^\n]*)?(?:\.{3}|…))$/i;

function literalText(node) {
  if (!node) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("placeholder");
  }
  return null;
}

function reportWaitText(context, node, value) {
  if (value && isVisibleJsxValue(node) && WAIT_TEXT.test(value.trim())) {
    context.report({ node, messageId: "replaceWithMotion" });
  }
}

function identifierText(context, node) {
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    const definition = variable?.defs[0];
    if (definition?.type === "Variable" && definition.node.parent?.kind === "const") {
      return literalText(definition.node.init);
    }
    scope = scope.upper;
  }
  return null;
}

function isVisibleJsxValue(node) {
  if (node.type === "JSXText") return true;
  let parent = node.parent;
  while (parent) {
    if (parent.type === "JSXAttribute") return parent.name.name === "placeholder";
    if (parent.type === "JSXExpressionContainer") {
      return parent.parent?.type !== "JSXAttribute" || parent.parent.name.name === "placeholder";
    }
    if (parent.type === "VariableDeclarator" || parent.type === "Program") return false;
    parent = parent.parent;
  }
  return false;
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
      Identifier(node) {
        reportWaitText(context, node, identifierText(context, node));
      },
    };
  },
};

export const visibleWaitTextPlugin = {
  rules: { "no-visible-wait-text": noVisibleWaitText },
};
