const sidecarDistDir = process.env["NEXT_DIST_DIR"]?.trim();

function normalizeDevOrigin(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0] || null;
  }
}

function allowedDevOrigins() {
  const origins = [
    normalizeDevOrigin(process.env["SPUR_SIDECAR_PUBLIC_HOST"]),
    normalizeDevOrigin(process.env["SPUR_SIDECAR_PUBLIC_URL"]),
  ].filter(Boolean);

  return [...new Set(origins)];
}

const configuredAllowedDevOrigins = allowedDevOrigins();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  ...(sidecarDistDir ? { distDir: sidecarDistDir } : {}),
  ...(configuredAllowedDevOrigins.length > 0
    ? { allowedDevOrigins: configuredAllowedDevOrigins }
    : {}),
};

export default nextConfig;
