import type { ChatLayout, VoiceRect } from "./snippet-protocol";

function contains(outer: VoiceRect, inner: VoiceRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function supportedVoiceStyle(style: CSSStyleDeclaration): boolean {
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    (style.clipPath && style.clipPath !== "none") ||
    (style.maskImage && style.maskImage !== "none") ||
    (style.perspective && style.perspective !== "none") ||
    (style.rotate && style.rotate !== "none" && style.rotate !== "0deg")
  )
    return false;
  if (
    style.scale &&
    style.scale !== "none" &&
    style.scale.split(/\s+/).some((value) => !(Number(value) > 0))
  )
    return false;
  if (!style.transform || style.transform === "none") return true;
  const match = /^matrix\(([^)]+)\)$/.exec(style.transform);
  if (!match) return false;
  const values = match[1].split(",").map(Number);
  return (
    values.length === 6 &&
    values.every(Number.isFinite) &&
    values[0] > 0 &&
    values[3] > 0 &&
    values[1] === 0 &&
    values[2] === 0
  );
}

export function mapVoiceRect(
  rect: VoiceRect,
  viewport: ChatLayout["viewport"],
  content: VoiceRect,
  clips: VoiceRect[],
): VoiceRect | null {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0)
    return null;
  const mapped = {
    x: content.x + (rect.x * content.width) / viewport.width,
    y: content.y + (rect.y * content.height) / viewport.height,
    width: (rect.width * content.width) / viewport.width,
    height: (rect.height * content.height) / viewport.height,
  };
  return [content, ...clips].every((clip) => contains(clip, mapped)) ? mapped : null;
}

// Parent geometry is read again in the activation event; child leases only grant placement.
export function placeVoiceSlots(
  frame: HTMLIFrameElement,
  region: HTMLElement,
  layout: ChatLayout | null,
  now = Date.now(),
): Array<{ target: string; rect: VoiceRect }> {
  if (
    !layout ||
    now - layout.receivedAt >= 750 ||
    !frame.isConnected ||
    !frame.offsetWidth ||
    !frame.offsetHeight
  )
    return [];
  const bounds = frame.getBoundingClientRect();
  const sx = bounds.width / frame.offsetWidth;
  const sy = bounds.height / frame.offsetHeight;
  const content = {
    x: bounds.left + frame.clientLeft * sx,
    y: bounds.top + frame.clientTop * sy,
    width: frame.clientWidth * sx,
    height: frame.clientHeight * sy,
  };
  const visual = window.visualViewport;
  const clips: VoiceRect[] = [
    {
      x: visual?.offsetLeft ?? 0,
      y: visual?.offsetTop ?? 0,
      width: visual?.width ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
    },
  ];
  for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      !supportedVoiceStyle(style) ||
      node.getAnimations?.().some((animation) => animation.playState === "running")
    )
      return [];
    if (
      node !== frame &&
      /(hidden|clip|scroll|auto)/.test(style.overflow + style.overflowX + style.overflowY)
    ) {
      const box = node.getBoundingClientRect();
      const scaleX = node.offsetWidth ? box.width / node.offsetWidth : 1;
      const scaleY = node.offsetHeight ? box.height / node.offsetHeight : 1;
      clips.push({
        x: box.left + node.clientLeft * scaleX,
        y: box.top + node.clientTop * scaleY,
        width: node.clientWidth * scaleX,
        height: node.clientHeight * scaleY,
      });
    }
  }
  const origin = region.getBoundingClientRect();
  const scaleX = region.offsetWidth ? origin.width / region.offsetWidth : sx;
  const scaleY = region.offsetHeight ? origin.height / region.offsetHeight : sy;
  return layout.slots.flatMap(({ target, rect }) => {
    const mapped = rect && mapVoiceRect(rect, layout.viewport, content, clips);
    return mapped
      ? [
          {
            target,
            rect: {
              x: (mapped.x - origin.left) / scaleX,
              y: (mapped.y - origin.top) / scaleY,
              width: mapped.width / scaleX,
              height: mapped.height / scaleY,
            },
          },
        ]
      : [];
  });
}
