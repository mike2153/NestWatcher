#!/usr/bin/env node

/**
 * Automated color replacement script
 * Replaces hardcoded Tailwind colors with semantic utility classes
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Color mapping rules
const replacements = [
  // Status chips
  { pattern: /bg-rose-500(?:\/\d+)?\s+(?:border\s+)?border-rose-\d+(?:\/\d+)?\s+text-rose-\d+/g, replacement: 'chip chip--error' },
  { pattern: /bg-red-500(?:\/\d+)?\s+(?:border\s+)?border-red-\d+(?:\/\d+)?\s+text-red-\d+/g, replacement: 'chip chip--error' },
  { pattern: /bg-emerald-500(?:\/\d+)?\s+(?:border\s+)?border-emerald-\d+(?:\/\d+)?\s+text-emerald-\d+/g, replacement: 'chip chip--success' },
  { pattern: /bg-green-500(?:\/\d+)?\s+(?:border\s+)?border-green-\d+(?:\/\d+)?\s+text-green-\d+/g, replacement: 'chip chip--success' },
  { pattern: /bg-amber-500(?:\/\d+)?\s+(?:border\s+)?border-amber-\d+(?:\/\d+)?\s+text-amber-\d+/g, replacement: 'chip chip--warning' },
  { pattern: /bg-yellow-500(?:\/\d+)?\s+(?:border\s+)?border-yellow-\d+(?:\/\d+)?\s+text-yellow-\d+/g, replacement: 'chip chip--warning' },

  // Individual color replacements
  { pattern: /text-rose-\d+/g, replacement: 'text-destructive' },
  { pattern: /text-red-\d+/g, replacement: 'text-destructive' },
  { pattern: /text-emerald-\d+/g, replacement: 'text-success' },
  { pattern: /text-green-\d+/g, replacement: 'text-success' },
  { pattern: /text-amber-\d+/g, replacement: 'text-warning' },
  { pattern: /text-yellow-\d+/g, replacement: 'text-warning' },

  { pattern: /bg-rose-\d+(?:\/\d+)?/g, replacement: 'bg-surface' },
  { pattern: /bg-red-\d+(?:\/\d+)?/g, replacement: 'bg-surface' },
  { pattern: /bg-white\/10/g, replacement: 'bg-surface' },
  { pattern: /bg-white\/20/g, replacement: 'bg-surface-medium' },
  { pattern: /bg-white\/30/g, replacement: 'bg-surface-strong' },

  // Border colors
  { pattern: /border-rose-\d+(?:\/\d+)?/g, replacement: 'border-light' },
  { pattern: /border-red-\d+(?:\/\d+)?/g, replacement: 'border-light' },
  { pattern: /border-white\/20/g, replacement: 'border-light' },
  { pattern: /border-white\/30/g, replacement: 'border-medium' },
  { pattern: /border-white\/50/g, replacement: 'border-strong' },

  // Text colors
  { pattern: /text-white\/70/g, replacement: 'text-secondary' },
  { pattern: /text-white\/60/g, replacement: 'text-tertiary' },
  { pattern: /text-white\/50/g, replacement: 'text-tertiary' },
  { pattern: /text-white\/40/g, replacement: 'text-disabled' },
  { pattern: /text-white\/35/g, replacement: 'text-disabled' },
  { pattern: /text-white(?!\w)/g, replacement: 'text-primary' },

  // Navigation specific
  { pattern: /hover:bg-white\/10/g, replacement: 'hover:bg-surface' },
  { pattern: /bg-white\/20.*?text-primary/g, replacement: 'nav-link--active' },

  // Buttons
  { pattern: /bg-gradient-to-r\s+from-slate-\d+\s+to-slate-\d+/g, replacement: 'btn btn--primary' },
  { pattern: /bg-white\/20\s+border\s+border-white\/30/g, replacement: 'btn btn--secondary' },
];

// File patterns to process
const filePatterns = [
  'packages/renderer/src/**/*.tsx',
  'packages/renderer/src/**/*.ts'
];

function processFile(filePath) {
  console.log(`Processing: ${filePath}`);

  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  replacements.forEach(({ pattern, replacement }) => {
    if (pattern.test(content)) {
      content = content.replace(pattern, replacement);
      changed = true;
    }
  });

  if (changed) {
    fs.writeFileSync(filePath, content);
    console.log(`  ✓ Updated ${filePath}`);
  } else {
    console.log(`  - No changes needed for ${filePath}`);
  }
}

function main() {
  console.log('🎨 Starting automated color migration...\n');

  filePatterns.forEach(pattern => {
    const files = glob.sync(pattern, {
      cwd: __dirname,
      absolute: true
    });

    files.forEach(processFile);
  });

  console.log('\n✨ Color migration complete!');
  console.log('\nNext steps:');
  console.log('1. Review the changes');
  console.log('2. Test the application');
  console.log('3. Make manual adjustments if needed');
}

// Check if glob is available
try {
  require.resolve('glob');
  main();
} catch (e) {
  console.log('Installing glob dependency...');
  const { execSync } = require('child_process');
  execSync('npm install glob', { stdio: 'inherit' });
  main();
}