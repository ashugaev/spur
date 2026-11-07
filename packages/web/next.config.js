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
  // `/p/<id>` and `/p/<id>/` differ: the page route itself redirects the bare form,
  // so relative asset URLs in a page resolve against its dir.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: "/p/:id/_spur/sdk.js", destination: "/spur/spur-sdk.v2.js" },
      { source: "/p/:id/_spur/theme.css", destination: "/spur/spur-page-theme.v2.css" },
    ];
  },
  ...(sidecarDistDir ? { distDir: sidecarDistDir } : {}),
  ...(configuredAllowedDevOrigins.length > 0
    ? { allowedDevOrigins: configuredAllowedDevOrigins }
    : {}),
};

export default nextConfig;
