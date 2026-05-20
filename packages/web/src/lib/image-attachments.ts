export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const IMAGE_ACCEPT = Array.from(IMAGE_TYPES).join(",");

export interface ImageAttachment {
  file: File;
  preview: string;
}

type ImageDataTransfer = DataTransfer & {
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

export async function imageAttachmentsFromFiles(
  files: FileList | File[] | null,
): Promise<ImageAttachment[]> {
  if (!files) {
    return [];
  }
  const images = Array.from(files).filter((file) => IMAGE_TYPES.has(file.type));
  return Promise.all(
    images.map(async (file) => ({
      file,
      preview: await fileToDataUrl(file),
    })),
  );
}

function ensureImageFilename(file: File, index: number): File {
  if (file.name.trim()) return file;
  const extension = file.type.split("/")[1] ?? "png";
  return new File([file], `clipboard-image-${index + 1}.${extension}`, {
    lastModified: file.lastModified,
    type: file.type,
  });
}

export function imageFilesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }

  const { files, items } = dataTransfer as ImageDataTransfer;
  const allFiles = files ? Array.from(files) : [];
  const itemFiles = items
    ? Array.from(items)
        .filter((item) => item.kind === "file" && IMAGE_TYPES.has(item.type))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
    : [];
  return [...allFiles, ...itemFiles]
    .filter((file, index, imageFiles) => {
      if (!IMAGE_TYPES.has(file.type)) return false;
      return (
        imageFiles.findIndex(
          (candidate) =>
            candidate.name === file.name &&
            candidate.type === file.type &&
            candidate.size === file.size,
        ) === index
      );
    })
    .map(ensureImageFilename);
}

export function encodeImageAttachments(
  attachments: ImageAttachment[],
): Array<{ name: string; data: string }> {
  return attachments.map((attachment) => ({
    name: sanitizeAttachmentFilename(attachment.file.name),
    data: attachment.preview.split(",")[1] ?? "",
  }));
}
