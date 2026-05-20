import { describe, expect, it } from "vitest";
import { imageFilesFromDataTransfer } from "@/lib/image-attachments";

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
