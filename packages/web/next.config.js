const sidecarDistDir = process.env["NEXT_DIST_DIR"]?.trim();

/** @type {import('next').NextConfig} */
const nextConfig = sidecarDistDir ? { distDir: sidecarDistDir } : {};

export default nextConfig;
