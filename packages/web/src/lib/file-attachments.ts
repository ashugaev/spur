export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

export async function fileAttachmentsFromFiles(
  files: FileList | File[] | null,
): Promise<FileAttachment[]> {
  if (!files) {
    return [];
  }
  return Promise.all(
    Array.from(files).map(async (file) => ({
      file,
      preview: await fileToDataUrl(file),
    })),
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
