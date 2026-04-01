const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { tmpdir } = require('node:os');

const extensionPath = join(__dirname, 'index.ts');
const source = readFileSync(extensionPath, 'utf8');

function parseAgent(raw) {
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(frontmatterMatch, 'expected frontmatter');

  const frontmatter = {};
  const lines = frontmatterMatch[1].replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const idx = line.indexOf(':');
    assert.ok(idx > 0, `invalid frontmatter line: ${line}`);

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (value === '|' || value === '>') {
      const blockLines = [];
      i++;
      for (; i < lines.length; i++) {
        const blockLine = lines[i];
        if (!blockLine.trim()) {
          blockLines.push('');
          continue;
        }
        if (!/^\s+/.test(blockLine)) {
          i--;
          break;
        }
        blockLines.push(blockLine.replace(/^\s{1,2}/, ''));
      }
      value = value === '>'
        ? blockLines
            .join('\n')
            .split('\n\n')
            .map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
            .join('\n\n')
        : blockLines.join('\n');
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return {
    name: frontmatter.name,
    customSystemPrompt: (frontmatter['system-prompt'] || '').trim(),
    systemPrompt: frontmatterMatch[2].trim(),
    systemPromptType:
      frontmatter['system-prompt-type'] === 'append' ? 'append' : 'replace',
  };
}

function buildAgentSystemPrompt(def) {
  return [def.customSystemPrompt, def.systemPrompt]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
}

test('agent-team defaults system-prompt-type to replace', () => {
  const parsed = parseAgent(`---
name: demo
system-prompt: |
  custom instructions
---
body instructions
`);

  assert.equal(parsed.systemPromptType, 'replace');
});

test('agent-team accepts explicit append system-prompt-type', () => {
  const parsed = parseAgent(`---
name: demo
system-prompt-type: append
system-prompt: |
  custom instructions
---
body instructions
`);

  assert.equal(parsed.systemPromptType, 'append');
});

test('agent-team builds combined prompt with custom prompt prepended to body', () => {
  const parsed = parseAgent(`---
name: demo
system-prompt: |
  custom instructions
---
body instructions
`);

  assert.equal(
    buildAgentSystemPrompt(parsed),
    'custom instructions\n\nbody instructions',
  );
});

test('agent-team runtime uses --system-prompt for default replace mode', () => {
  assert.match(source, /state\.def\.systemPromptType === "append"\s*\?\s*"--append-system-prompt"\s*:\s*"--system-prompt"/);
});

test('agent-team runtime can use --append-system-prompt for append mode', () => {
  assert.match(source, /"--append-system-prompt"/);
});
