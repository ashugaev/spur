export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Animated GIFs are excluded from downscaling: redrawing to a canvas would
// flatten the animation to a single frame.
const DOWNSCALE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export const DOWNSCALE_MAX_DIMENSION = 1600;
export const DOWNSCALE_BYTE_THRESHOLD = 2 * 1024 * 1024; // 2 MB

const REENCODE_QUALITY = 0.85;
const WEBP_MIME = "image/webp";
const JPEG_MIME = "image/jpeg";

// Single source for mapping a canvas-produced blob's actual MIME type to a
// filename extension. An unsupported `toBlob` type silently yields image/png
// per the canvas spec, so the extension must always be derived from the blob
// that came back, never assumed from the type that was requested.
const EXTENSION_BY_BLOB_MIME: Record<string, string> = {
  [WEBP_MIME]: "webp",
  [JPEG_MIME]: "jpg",
  "image/png": "png",
};

// Kept under the daemon's 15 MB JSON body cap (v2/src/server.ts readJsonBody
// maxBytes override) to leave headroom for JSON overhead and other fields.
export const MAX_ATTACHMENTS_PAYLOAD_BYTES = 14 * 1024 * 1024;

export const ATTACHMENTS_TOO_LARGE_MESSAGE =
  "Attachments too large to send — try a smaller image or fewer files.";

export interface FileAttachment {
  file: File;
  preview: string;
}

type FlexibleDataTransfer = DataTransfer & {
  files?: FileList | File[];
  items?: DataTransferItemList | DataTransferItem[];
};

export function sanitizeAttachmentFilename(name: string): string {
  return name.replace(/[^\w.-]/g, "_");
}

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function shouldDownscaleImage(
  mimeType: string,
  width: number,
  height: number,
  byteSize: number,
): boolean {
  if (!DOWNSCALE_MIME_TYPES.has(mimeType)) {
    return false;
  }
  return (
    width > DOWNSCALE_MAX_DIMENSION ||
    height > DOWNSCALE_MAX_DIMENSION ||
    byteSize > DOWNSCALE_BYTE_THRESHOLD
  );
}

export function computeScaledDimensions(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height };
  }
  const scale = maxDimension / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function withExtension(name: string, extension: string): string {
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base || "image"}.${extension}`;
}

function loadImageDimensions(
  file: File,
): Promise<{ image: HTMLImageElement; width: number; height: number; revoke: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        revoke: () => URL.revokeObjectURL(url),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to decode image"));
    };
    image.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function reencodeImage(
  image: HTMLImageElement,
  width: number,
  height: number,
): Promise<{ blob: Blob; extension: string } | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);

  const webpBlob = await canvasToBlob(canvas, WEBP_MIME, REENCODE_QUALITY);
  const blob =
    webpBlob && webpBlob.type === WEBP_MIME
      ? webpBlob
      : await canvasToBlob(canvas, JPEG_MIME, REENCODE_QUALITY);
  if (!blob) return null;

  const extension = EXTENSION_BY_BLOB_MIME[blob.type];
  if (!extension) return null;
  return { blob, extension };
}

async function downscaleImageFile(file: File): Promise<File> {
  let dimensions: Awaited<ReturnType<typeof loadImageDimensions>> | null = null;
  try {
    dimensions = await loadImageDimensions(file);
    const { image, width, height, revoke } = dimensions;
    if (!shouldDownscaleImage(file.type, width, height, file.size)) {
      revoke();
      return file;
    }
    const scaled = computeScaledDimensions(width, height, DOWNSCALE_MAX_DIMENSION);
    const reencoded = await reencodeImage(image, scaled.width, scaled.height);
    revoke();
    if (!reencoded) {
      return file;
    }
    return new File([reencoded.blob], withExtension(file.name, reencoded.extension), {
      type: reencoded.blob.type,
      lastModified: file.lastModified,
    });
  } catch {
    dimensions?.revoke();
    return file;
  }
}

export async function fileAttachmentsFromFiles(
  files: FileList | File[] | null,
): Promise<FileAttachment[]> {
  if (!files) {
    return [];
  }
  return Promise.all(
    Array.from(files).map(async (file) => {
      const optimized = IMAGE_TYPES.has(file.type) ? await downscaleImageFile(file) : file;
      return {
        file: optimized,
        preview: await fileToDataUrl(optimized),
      };
    }),
  );
}

function ensureClipboardFilename(file: File, index: number): File {
  if (file.name.trim()) return file;
  const subtype = file.type.split("/")[1];
  const extension = subtype && subtype.length > 0 ? subtype : "bin";
  const prefix = file.type.startsWith("image/") ? "clipboard-image-" : "clipboard-file-";
  return new File([file], `${prefix}${index + 1}.${extension}`, {
    lastModified: file.lastModified,
    type: file.type,
  });
}

export function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }

  const { files, items } = dataTransfer as FlexibleDataTransfer;
  const allFiles = files ? Array.from(files) : [];
  const itemFiles = items
    ? Array.from(items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
    : [];
  return [...allFiles, ...itemFiles]
    .filter(
      (file, index, candidates) =>
        candidates.findIndex(
          (candidate) =>
            candidate.name === file.name &&
            candidate.type === file.type &&
            candidate.size === file.size,
        ) === index,
    )
    .map(ensureClipboardFilename);
}

export function imageFilesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  return filesFromDataTransfer(dataTransfer).filter((file) => IMAGE_TYPES.has(file.type));
}

export function encodeFileAttachments(
  attachments: FileAttachment[],
): Array<{ name: string; data: string }> {
  return attachments.map((attachment) => ({
    name: sanitizeAttachmentFilename(attachment.file.name),
    data: attachment.preview.split(",")[1] ?? "",
  }));
}

/** Throws with a user-facing message when the encoded payload would be rejected server-side. */
export function assertAttachmentsWithinLimit(encoded: Array<{ name: string; data: string }>): void {
  const totalBytes = encoded.reduce((sum, attachment) => sum + attachment.data.length, 0);
  if (totalBytes > MAX_ATTACHMENTS_PAYLOAD_BYTES) {
    throw new Error(ATTACHMENTS_TOO_LARGE_MESSAGE);
  }
}
