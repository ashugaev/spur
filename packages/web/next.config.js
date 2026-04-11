const sidecarDistDir = process.env["NEXT_DIST_DIR"]?.trim();

// Build-time version: vYYYY.MM.DD HH:MM (UTC)
const buildVersion = new Date()
  .toISOString()
  .replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}).*/, "v$1.$2.$3 $4:$5");

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(sidecarDistDir ? { distDir: sidecarDistDir } : {}),
  env: {
    NEXT_PUBLIC_BUILD_VERSION: buildVersion,
  },
};

export default nextConfig;
