import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as fileAttachmentsModule from "@/lib/file-attachments";

const filesFromDataTransferMock = vi.fn<(dt: DataTransfer | null) => File[]>(() => []);

vi.mock("@/lib/file-attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof fileAttachmentsModule>();
  return {
    ...actual,
    filesFromDataTransfer: (dt: DataTransfer | null) => filesFromDataTransferMock(dt),
  };
});

import { FileAttachmentTextarea } from "@/components/FileAttachmentTextarea";

function HostedTextarea(props: {
  value: string;
  onChange: (value: string) => void;
  onAddFiles?: (files: FileList | File[] | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  return (
    <FileAttachmentTextarea
      ariaLabel="composer"
      attachments={[]}
      onAddFiles={props.onAddFiles ?? vi.fn()}
      onChange={props.onChange}
      onRemoveAttachment={vi.fn()}
      placeholder="Write..."
      textareaRef={ref}
      value={props.value}
    />
  );
}

describe("FileAttachmentTextarea", () => {
  beforeEach(() => {
    filesFromDataTransferMock.mockReset();
  });

  it("paste with files calls onAddFiles", () => {
    const files = [new File(["x"], "a.png", { type: "image/png" })];
    filesFromDataTransferMock.mockReturnValueOnce(files);
    const onAddFiles = vi.fn();
    render(<HostedTextarea onAddFiles={onAddFiles} onChange={vi.fn()} value="" />);
    fireEvent.paste(screen.getByRole("textbox", { name: "composer" }));
    expect(onAddFiles).toHaveBeenCalledWith(files);
  });

  it("drop with files calls onAddFiles", () => {
    const files = [new File(["x"], "b.png", { type: "image/png" })];
    filesFromDataTransferMock.mockReturnValueOnce(files);
    const onAddFiles = vi.fn();
    render(<HostedTextarea onAddFiles={onAddFiles} onChange={vi.fn()} value="" />);
    fireEvent.drop(screen.getByRole("textbox", { name: "composer" }));
    expect(onAddFiles).toHaveBeenCalledWith(files);
  });

  it("textarea change calls onChange with new value", () => {
    const onChange = vi.fn();
    render(<HostedTextarea onChange={onChange} value="" />);
    fireEvent.change(screen.getByRole("textbox", { name: "composer" }), {
      target: { value: "hello" },
    });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("renders clear button when value.length > 0", () => {
    render(<HostedTextarea onChange={vi.fn()} value="text" />);
    expect(screen.getByRole("button", { name: "Clear composer" })).toBeVisible();
  });

  it("clear button calls onChange('') and focuses textarea", () => {
    const onChange = vi.fn();
    render(<HostedTextarea onChange={onChange} value="text" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear composer" }));
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByRole("textbox", { name: "composer" })).toHaveFocus();
  });
});
