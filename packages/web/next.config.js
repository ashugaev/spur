/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  serverExternalPackages: ["@composio/core"],
};

export default nextConfig;
