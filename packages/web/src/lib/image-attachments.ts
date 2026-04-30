export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const IMAGE_ACCEPT = Array.from(IMAGE_TYPES).join(",");

export interface ImageAttachment {
  file: File;
  preview: string;
}

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
  files: FileList | null,
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

export function encodeImageAttachments(
  attachments: ImageAttachment[],
): Array<{ name: string; data: string }> {
  return attachments.map((attachment) => ({
    name: sanitizeAttachmentFilename(attachment.file.name),
    data: attachment.preview.split(",")[1] ?? "",
  }));
}
