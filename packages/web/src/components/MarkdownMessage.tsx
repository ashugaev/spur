"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  text: string;
}

export function MarkdownMessage({ text }: MarkdownMessageProps) {
  return (
    <div
      className={[
        "break-words text-inherit",
        "[&>*:first-child]:mt-0",
        "[&>*:last-child]:mb-0",
        "[&_a]:text-[var(--color-accent)]",
        "[&_a]:underline",
        "[&_blockquote]:my-2",
        "[&_blockquote]:border-l-2",
        "[&_blockquote]:border-[var(--color-border-strong)]",
        "[&_blockquote]:pl-3",
        "[&_code]:bg-[var(--color-bg-base)]",
        "[&_code]:px-1",
        "[&_code]:py-0.5",
        "[&_code]:font-mono",
        "[&_code]:text-[0.95em]",
        "[&_h1]:mt-3 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-bold",
        "[&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-bold",
        "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-bold",
        "[&_hr]:my-3 [&_hr]:border-[var(--color-border-default)]",
        "[&_li+li]:mt-1",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_p]:my-0 [&_p+p]:mt-2",
        "[&_pre]:my-2",
        "[&_pre]:overflow-x-auto",
        "[&_pre]:border",
        "[&_pre]:border-[var(--color-border-default)]",
        "[&_pre]:bg-[var(--color-bg-base)]",
        "[&_pre]:p-2",
        "[&_pre_code]:bg-transparent",
        "[&_pre_code]:p-0",
        "[&_table]:my-2",
        "[&_table]:block",
        "[&_table]:max-w-full",
        "[&_table]:overflow-x-auto",
        "[&_table]:border-collapse",
        "[&_table]:text-left",
        "[&_tbody_tr:nth-child(odd)]:bg-white/[0.02]",
        "[&_td]:border",
        "[&_td]:border-[var(--color-border-default)]",
        "[&_td]:px-2",
        "[&_td]:py-1",
        "[&_th]:border",
        "[&_th]:border-[var(--color-border-default)]",
        "[&_th]:px-2",
        "[&_th]:py-1",
        "[&_th]:font-bold",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
      ].join(" ")}
    >
      <ReactMarkdown
        components={{
          a: ({ ...props }) => <a {...props} rel="noreferrer" target="_blank" />,
        }}
        remarkPlugins={[remarkGfm]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
