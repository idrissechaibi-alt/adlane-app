// Postinstall script - crée le shim manquant pour react-native-gesture-handler
// Compatible avec React Native 0.76+ qui a supprimé Libraries/Renderer/shims/ReactNative
const fs = require('fs');
const path = require('path');

const shimContent = `'use strict';
// Shim for React Native 0.76+ compatibility
// The original path react-native/Libraries/Renderer/shims/ReactNative was removed in RN 0.76
module.exports = require('./ReactFabric');
`;

const shimPath = path.join(
  __dirname,
  '..',
  'node_modules/react-native/Libraries/Renderer/shims/ReactNative.js'
);

try {
  const targetDir = path.dirname(shimPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  if (!fs.existsSync(shimPath)) {
    fs.writeFileSync(shimPath, shimContent, 'utf8');
    console.log('[postinstall] Created RN 0.76+ shim: react-native/Libraries/Renderer/shims/ReactNative.js');
  }
} catch (e) {
  console.error('[postinstall] Failed to create shim:', e.message);
}