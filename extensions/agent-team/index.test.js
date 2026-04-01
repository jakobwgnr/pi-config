const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

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

test('agent-team scans global pi agent directory for agent definitions', () => {
  assert.match(
    source,
    /join\(homedir\(\), "\.pi", "agent", "agents"\)/,
  );
});

test('dmi-development-team includes the etl-designer agent', () => {
  const teamsSource = readFileSync(join(__dirname, '..', '..', 'agents', 'teams.yaml'), 'utf8');
  assert.match(teamsSource, /dmi-development-team:[\s\S]*- etl-designer/);
});

test('etl-designer agent definition declares adamms skill and readiness workflow', () => {
  const raw = readFileSync(join(__dirname, '..', '..', 'agents', 'etl-designer.md'), 'utf8');
  const parsed = parseAgent(raw);

  assert.equal(parsed.name, 'etl-designer');
  assert.match(raw, /^skill: adamms$/m);
  assert.match(raw, /status `done`/);
  assert.match(raw, /\/answer/);
  assert.match(raw, /UNION/i);
});

test('agent-team empty state mentions global pi agent directory', () => {
  assert.match(source, /~\/\.pi\/agent\/agents\//);
});

test('agent-team widget handles Space to toggle expanded agent card', () => {
  assert.match(source, /if \(keyData === " "\)/);
  assert.match(source, /widgetState\.expandedAgent = selectedAgent\.def\.name/);
  assert.match(source, /widgetState\.expandedAgent = null/);
});

test('agent-team registers a focus command for reliable keyboard interaction', () => {
  assert.match(source, /pi\.registerCommand\("agent-team:focus"/);
  assert.match(source, /ctx\.ui\.showOverlay\(focusComponent/);
  assert.match(source, /ctx\.ui\.setFocus\(focusComponent\)/);
  assert.match(source, /Space to expand\/collapse, Esc to return to the editor/);
  assert.match(source, /Arrow keys to navigate · Space to expand/);
  assert.match(source, /Space to collapse/);
});

test('agent-team focus overlay uses DynamicBorder from pi-coding-agent instead of pi-tui', () => {
  assert.match(source, /import \{[\s\S]*DynamicBorder,[\s\S]*type ExtensionAPI,[\s\S]*\} from "@mariozechner\/pi-coding-agent"/);
  assert.match(source, /type AutocompleteItem,[\s\S]*\} from "@mariozechner\/pi-tui"/);
  assert.match(source, /new DynamicBorder\(\(value: string\) => value\)/);
});

test('agent-team focus mode exits on Escape and restores editor focus', () => {
  assert.match(source, /matchesKey\(keyData, Key\.escape\)/);
  assert.match(source, /ctx\.ui\.setFocus\(\(ctx as any\)\.editor\)/);
  assert.match(source, /ctx\.ui\.hideOverlay\(\)/);
});

test('agent-team widget hides other agents while one card is expanded', () => {
  assert.match(source, /const agents = widgetState\.expandedAgent\s*\? allAgents\.filter\(\(agent\) => agent\.def\.name === widgetState\.expandedAgent\)\s*:\s*allAgents/);
  assert.match(source, /const cols = widgetState\.expandedAgent \? 1 : Math\.min\(gridCols, agents\.length\)/);
});

test('agent-team expanded card shows active work details', () => {
  assert.match(source, /Doing: \$\{currentWork\}/);
  assert.match(source, /state\.status === "running"\s*\? state\.lastWork \|\| state\.task \|\| "Working\.\.\."/);
  assert.match(source, /Role: \$\{description\}/);
});
