import { describe, expect, it } from "vitest";
import { filesFromDataTransfer, imageFilesFromDataTransfer } from "@/lib/file-attachments";

type TestDataTransferItem = {
  getAsFile: () => File | null;
  kind: string;
  type: string;
};

function dataTransfer(files: File[], items: TestDataTransferItem[] = []): DataTransfer {
  return { files, items } as unknown as DataTransfer;
}

describe("image attachments", () => {
  it("reads pasted images from clipboard items when files is empty", () => {
    const image = new File(["PNG"], "clipboard.png", { type: "image/png" });

    const files = imageFilesFromDataTransfer(
      dataTransfer(
        [],
        [
          { getAsFile: () => image, kind: "file", type: "image/png" },
          { getAsFile: () => null, kind: "string", type: "text/plain" },
        ],
      ),
    );

    expect(files).toEqual([image]);
  });

  it("ignores text-only clipboard items", () => {
    const files = imageFilesFromDataTransfer(
      dataTransfer([], [{ getAsFile: () => null, kind: "string", type: "text/plain" }]),
    );

    expect(files).toEqual([]);
  });

  it("deduplicates images exposed through both files and items", () => {
    const image = new File(["PNG"], "clipboard.png", { type: "image/png" });

    const files = imageFilesFromDataTransfer(
      dataTransfer([image], [{ getAsFile: () => image, kind: "file", type: "image/png" }]),
    );

    expect(files).toEqual([image]);
  });

  it("names unnamed clipboard images", () => {
    const image = new File(["PNG"], "", { type: "image/png" });

    const files = imageFilesFromDataTransfer(
      dataTransfer([], [{ getAsFile: () => image, kind: "file", type: "image/png" }]),
    );

    expect(files[0]?.name).toBe("clipboard-image-1.png");
  });
});

describe("file attachments", () => {
  it("accepts a pdf clipboard item", () => {
    const pdf = new File(["%PDF"], "report.pdf", { type: "application/pdf" });

    const files = filesFromDataTransfer(
      dataTransfer([], [{ getAsFile: () => pdf, kind: "file", type: "application/pdf" }]),
    );

    expect(files).toEqual([pdf]);
  });

  it("accepts a text/plain clipboard item", () => {
    const text = new File(["hello"], "notes.txt", { type: "text/plain" });

    const files = filesFromDataTransfer(
      dataTransfer([], [{ getAsFile: () => text, kind: "file", type: "text/plain" }]),
    );

    expect(files).toEqual([text]);
  });

  it("ignores non-file (string) clipboard items", () => {
    const files = filesFromDataTransfer(
      dataTransfer([], [{ getAsFile: () => null, kind: "string", type: "text/plain" }]),
    );

    expect(files).toEqual([]);
  });

  it("deduplicates files exposed through both files and items", () => {
    const pdf = new File(["%PDF"], "report.pdf", { type: "application/pdf" });

    const files = filesFromDataTransfer(
      dataTransfer([pdf], [{ getAsFile: () => pdf, kind: "file", type: "application/pdf" }]),
    );

    expect(files).toEqual([pdf]);
  });

  it("auto-names a nameless clipboard blob with no usable extension as .bin", () => {
    const blob = new File(["data"], "", { type: "" });

    const files = filesFromDataTransfer(
      dataTransfer([], [{ getAsFile: () => blob, kind: "file", type: "" }]),
    );

    expect(files[0]?.name).toBe("clipboard-file-1.bin");
  });
});
