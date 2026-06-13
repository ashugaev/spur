import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAttachmentPreviewStrip, FilePickerButton } from "@/components/FileAttachmentControls";
import type { FileAttachment } from "@/lib/file-attachments";

function imageAttachment(name = "shot.png"): FileAttachment {
  return {
    file: new File(["x"], name, { type: "image/png" }),
    preview: "data:image/png;base64,AAA",
  };
}

function fileAttachment(name: string, size: number, type = "application/pdf"): FileAttachment {
  const file = new File(["x".repeat(size)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return { file, preview: "data:application/pdf;base64,AAA" };
}

describe("FileAttachmentPreviewStrip", () => {
  it("renders nothing for empty attachments", () => {
    const { container } = render(
      <FileAttachmentPreviewStrip attachments={[]} onRemoveAttachment={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders image preview with remove button", () => {
    render(
      <FileAttachmentPreviewStrip
        attachments={[imageAttachment("hero.png")]}
        onRemoveAttachment={vi.fn()}
      />,
    );
    const img = screen.getByAltText("hero.png");
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAA");
    expect(screen.getByRole("button", { name: "Remove hero.png" })).toBeVisible();
  });

  it("renders non-image file showing name and human-readable size", () => {
    render(
      <FileAttachmentPreviewStrip
        attachments={[fileAttachment("notes.pdf", 2048)]}
        onRemoveAttachment={vi.fn()}
      />,
    );
    expect(screen.getByText("notes.pdf")).toBeVisible();
    expect(screen.getByText("2 KB")).toBeVisible();
  });

  it("remove button calls onRemoveAttachment with correct index", () => {
    const onRemoveAttachment = vi.fn();
    render(
      <FileAttachmentPreviewStrip
        attachments={[imageAttachment("a.png"), imageAttachment("b.png")]}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove b.png" }));
    expect(onRemoveAttachment).toHaveBeenCalledWith(1);
  });
});

describe("FilePickerButton", () => {
  const originalClick = HTMLInputElement.prototype.click;

  afterEach(() => {
    HTMLInputElement.prototype.click = originalClick;
  });

  it("click triggers underlying file input click", () => {
    const clickSpy = vi.fn();
    HTMLInputElement.prototype.click = clickSpy;
    render(<FilePickerButton onAddFiles={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
    expect(clickSpy).toHaveBeenCalled();
  });
});
