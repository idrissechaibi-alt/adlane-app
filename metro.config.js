const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Ensure TypeScript files are properly resolved
config.resolver.sourceExts = [
  'expo.ts',
  'expo.tsx',
  'expo.js',
  'expo.jsx',
  ...config.resolver.sourceExts
];

module.exports = config;