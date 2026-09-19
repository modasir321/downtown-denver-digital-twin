import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  transpilePackages: ["mapbox-gl", "cesium"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      cesium: path.resolve(process.cwd(), "node_modules/cesium"),
    };
    config.resolve.fallback = {
      ...config.resolve.fallback,
      http: false,
      https: false,
      zlib: false,
      url: false,
    };
    return config;
  },
};

export default nextConfig;
