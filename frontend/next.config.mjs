/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // Hide the Next dev badge: it sits over the bottom-left of the UI,
  // which is exactly where a screen recording of the dev server looks.
  devIndicators: false,
};

export default nextConfig;
