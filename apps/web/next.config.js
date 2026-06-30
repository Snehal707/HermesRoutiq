/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@hermes-routiq/shared"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "mapbox-gl": "maplibre-gl",
    };
    return config;
  },
};

module.exports = nextConfig;
