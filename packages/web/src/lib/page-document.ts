import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { CatalogPage } from "./pages-client";

type Element = DefaultTreeAdapterMap["element"];

export function augmentPageDocument(html: string, page: CatalogPage): string {
  const document = parse(html);
  const root = document.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "head",
  );
  if (!head) throw new Error("Page document has no head");
  const attr = (node: Element, name: string) =>
    node.attrs.find((item) => item.name === name)?.value.toLowerCase();
  head.childNodes = head.childNodes.filter((node) => {
    if (!("tagName" in node)) return true;
    if (node.tagName === "title" || node.attrs.some((item) => item.name === "data-spur-platform"))
      return false;
    if (
      node.tagName === "link" &&
      ["icon", "shortcut icon", "apple-touch-icon", "manifest"].includes(attr(node, "rel") ?? "")
    )
      return false;
    return !(
      node.tagName === "meta" &&
      ["application-name", "apple-mobile-web-app-title", "apple-mobile-web-app-capable"].includes(
        attr(node, "name") ?? "",
      )
    );
  });
  const base = `${page.url}_spur/`;
  const additions = parseFragment(
    `<title></title><meta name="application-name"><meta name="apple-mobile-web-app-title"><meta name="apple-mobile-web-app-capable" content="yes"><link rel="manifest" href="${base}manifest.webmanifest"><link rel="icon" type="image/png" href="${base}icon-32.png"><link rel="apple-touch-icon" href="${base}icon-180.png"><script data-spur-platform src="${base}sdk.js"></script>`,
  ).childNodes;
  for (const node of additions) {
    if (!("tagName" in node)) continue;
    node.parentNode = head;
    if (node.tagName === "title")
      node.childNodes.push({ nodeName: "#text", value: page.title, parentNode: node });
    if (
      node.tagName === "meta" &&
      ["application-name", "apple-mobile-web-app-title"].includes(attr(node, "name") ?? "")
    )
      node.attrs.push({ name: "content", value: page.title });
  }
  // Run the platform SDK before authored scripts, without changing their relative URLs.
  head.childNodes.unshift(...additions);
  return serialize(document);
}
