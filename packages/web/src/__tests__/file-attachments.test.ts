import { describe, expect, it } from "vitest";
import {
  assertAttachmentsWithinLimit,
  ATTACHMENTS_TOO_LARGE_MESSAGE,
  computeScaledDimensions,
  DOWNSCALE_BYTE_THRESHOLD,
  DOWNSCALE_MAX_DIMENSION,
  filesFromDataTransfer,
  imageFilesFromDataTransfer,
  MAX_ATTACHMENTS_PAYLOAD_BYTES,
  shouldDownscaleImage,
} from "@/lib/file-attachments";

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

describe("shouldDownscaleImage", () => {
  it("skips images within both the dimension and byte budget", () => {
    expect(shouldDownscaleImage("image/png", 800, 600, 100_000)).toBe(false);
  });

  it("downscales when width exceeds the max dimension", () => {
    expect(shouldDownscaleImage("image/jpeg", DOWNSCALE_MAX_DIMENSION + 1, 600, 100_000)).toBe(
      true,
    );
  });

  it("downscales when height exceeds the max dimension", () => {
    expect(shouldDownscaleImage("image/webp", 600, DOWNSCALE_MAX_DIMENSION + 1, 100_000)).toBe(
      true,
    );
  });

  it("downscales when byte size exceeds the threshold even if dimensions are small", () => {
    expect(shouldDownscaleImage("image/png", 400, 400, DOWNSCALE_BYTE_THRESHOLD + 1)).toBe(true);
  });

  it("never downscales animated gifs", () => {
    expect(
      shouldDownscaleImage("image/gif", DOWNSCALE_MAX_DIMENSION * 4, DOWNSCALE_MAX_DIMENSION * 4, DOWNSCALE_BYTE_THRESHOLD * 4),
    ).toBe(false);
  });
});

describe("computeScaledDimensions", () => {
  it("leaves dimensions untouched when already within bounds", () => {
    expect(computeScaledDimensions(1200, 800, 1600)).toEqual({ width: 1200, height: 800 });
  });

  it("scales a landscape image down to fit the max dimension", () => {
    expect(computeScaledDimensions(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
  });

  it("scales a portrait image down to fit the max dimension", () => {
    expect(computeScaledDimensions(1600, 3200, 1600)).toEqual({ width: 800, height: 1600 });
  });

  it("never scales a dimension down to zero", () => {
    expect(computeScaledDimensions(1, 10_000, 1600)).toEqual({ width: 1, height: 1600 });
  });
});

describe("assertAttachmentsWithinLimit", () => {
  it("does not throw when the encoded payload is within the limit", () => {
    expect(() => assertAttachmentsWithinLimit([{ name: "a.png", data: "a".repeat(100) }])).not
      .toThrow();
  });

  it("throws the shared oversize message when the encoded payload exceeds the limit", () => {
    const encoded = [{ name: "a.png", data: "a".repeat(MAX_ATTACHMENTS_PAYLOAD_BYTES + 1) }];
    expect(() => assertAttachmentsWithinLimit(encoded)).toThrow(ATTACHMENTS_TOO_LARGE_MESSAGE);
  });

  it("sums bytes across multiple attachments", () => {
    const half = Math.ceil(MAX_ATTACHMENTS_PAYLOAD_BYTES / 2) + 1;
    const encoded = [
      { name: "a.png", data: "a".repeat(half) },
      { name: "b.png", data: "b".repeat(half) },
    ];
    expect(() => assertAttachmentsWithinLimit(encoded)).toThrow(ATTACHMENTS_TOO_LARGE_MESSAGE);
  });
});
