#!/usr/bin/env node

/**
 * Fix CapacitorCordova AND Capacitor header files that use double-quoted
 * includes instead of angle-bracket includes required for framework headers.
 *
 * This script runs automatically after npm install to ensure the fix persists.
 */

const fs = require('fs');
const path = require('path');

// --- CapacitorCordova headers ---
const cordovaHeadersDir = path.join(
  __dirname,
  'node_modules',
  '@capacitor',
  'ios',
  'CapacitorCordova',
  'CapacitorCordova',
  'Classes',
  'Public'
);

const cordovaUmbrellaHeader = path.join(
  __dirname,
  'node_modules',
  '@capacitor',
  'ios',
  'CapacitorCordova',
  'CapacitorCordova',
  'CapacitorCordova.h'
);

function fixCordovaFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[fix-headers] Skipping (not found): ${filePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  // Replace #import "CDVXXX.h" with #import <Cordova/CDVXXX.h>
  const fixed = content.replace(
    /#import "(CDV[^"]+\.h)"/g,
    '#import <Cordova/$1>'
  );

  if (content !== fixed) {
    fs.writeFileSync(filePath, fixed, 'utf8');
    console.log(`[fix-headers] Fixed Cordova: ${path.basename(filePath)}`);
  }
}

// --- Capacitor framework headers ---
const capacitorHeadersDir = path.join(
  __dirname,
  'node_modules',
  '@capacitor',
  'ios',
  'Capacitor',
  'Capacitor'
);

function fixCapacitorFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[fix-headers] Skipping (not found): ${filePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  // Replace #import "CAPXXX.h" with #import <Capacitor/CAPXXX.h>
  const fixed = content.replace(
    /#import "(CAP[^"]+\.h)"/g,
    '#import <Capacitor/$1>'
  );

  if (content !== fixed) {
    fs.writeFileSync(filePath, fixed, 'utf8');
    console.log(`[fix-headers] Fixed Capacitor: ${path.basename(filePath)}`);
  }
}

// Fix all CapacitorCordova .h files
if (fs.existsSync(cordovaHeadersDir)) {
  const files = fs.readdirSync(cordovaHeadersDir).filter((f) => f.endsWith('.h'));
  files.forEach((file) => {
    fixCordovaFile(path.join(cordovaHeadersDir, file));
  });
  fixCordovaFile(cordovaUmbrellaHeader);
} else {
  console.log('[fix-headers] CapacitorCordova headers directory not found, skipping.');
}

// Fix all Capacitor framework .h files
if (fs.existsSync(capacitorHeadersDir)) {
  const files = fs.readdirSync(capacitorHeadersDir).filter((f) => f.endsWith('.h'));
  files.forEach((file) => {
    fixCapacitorFile(path.join(capacitorHeadersDir, file));
  });
} else {
  console.log('[fix-headers] Capacitor headers directory not found, skipping.');
}

console.log('[fix-headers] Done.');