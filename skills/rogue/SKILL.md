---
name: rogue
description: Inspect and work with Rogue job repositories that define executable jobs in rogue/ YAML and templates/ YAML. Use when asked to analyze a rogue job, explain rogue dependencies, inspect Rogue templates, determine execution order, or understand tags, DEPENDENCY_GRAPH, Pebble variables, or shebang-driven template commands.
---

# Rogue

Inspect Rogue job repositories by reading job YAML from `rogue/` and template YAML from `templates/`, then explain what will execute and in which order.

## Step 1: Confirm the repository layout

Look for these paths first:

- `rogue/` — job definitions
- `templates/` — template definitions
- optional companion folders such as `rogue-extract/`, `rogue-load/`, or `ifttt/`
- generator/config files such as `nil.nil` that show how YAML is loaded into metadata tables

Treat each file under `rogue/` as a Rogue job definition.
Treat each file under `templates/` as a template definition.

## Step 2: Read the job YAML before making claims

For each relevant job file in `rogue/`, extract at least these fields when present:

- `ID`
- `ENABLED`
- `TAGS`
- `DEPENDENCY_GRAPH`
- `SETUP_TEMPLATE_ID`
- `PRE_ACTION_TEMPLATE_ID`
- `MAIN_TEMPLATE_ID`
- `POST_ACTION_TEMPLATE_ID`
- `TEARDOWN_TEMPLATE_ID`
- `SID_TEMPLATE_ID`
- `TABLES`
- `OPTION`

Assume the job is primarily defined by template references plus metadata.

If `TAGS`, `TABLES`, or `DEPENDENCY_GRAPH` are YAML block scalars containing nested YAML text, treat the scalar content as the meaningful value and parse it mentally before summarizing.

## Step 3: Resolve execution order

When explaining what a job does, use this template execution order when the referenced IDs are present:

1. `SETUP_TEMPLATE_ID`
2. `PRE_ACTION_TEMPLATE_ID`
3. `MAIN_TEMPLATE_ID`
4. `POST_ACTION_TEMPLATE_ID`
5. `TEARDOWN_TEMPLATE_ID`

Do not invent missing stages. If a stage field is null or absent, skip it.

If `SID_TEMPLATE_ID` is present, report it separately as a SID-related template reference rather than folding it into the standard action order unless the repository clearly documents a different runtime sequence.

## Step 4: Resolve template definitions

For each referenced template ID, open the matching YAML in `templates/` and extract:

- `ID`
- `OPTION`
- `TEMPLATE`

Match templates by `ID`, not just filename.

Templates usually contain SQL, but they may also contain custom command bodies. Detect command-style templates by checking the first non-empty line of the `TEMPLATE` body for a shebang such as:

- `#!scrat`
- other `#!...` interpreters if present

If there is no shebang, assume the template body is intended to execute as SQL unless repository evidence shows otherwise.

## Step 5: Interpret variables and table mappings

Treat placeholders inside job and template bodies as Pebble template expressions, for example:

- `{{schema}}`
- `{{dest.schema}}`
- `{{bank | numberformat('000') }}`
- `{{stage | upper }}`

Do not rewrite Pebble syntax into another template language.

When `TABLES` is present, use it to explain source and destination objects referenced by the job. A common pattern is a list like:

- `src:<schema>.<table>`
- `dest:<schema>.<table>`

Use those mappings to make the SQL easier to explain, but keep the original Pebble expressions intact when quoting values.

## Step 6: Interpret tags and dependencies

Use `TAGS` to explain job selection or grouping. If the user asks which jobs are executable for a tag, identify jobs whose `TAGS` include that tag.

Use `DEPENDENCY_GRAPH` to explain cross-job prerequisites between Rogue job YAMLs. Treat it as defining dependencies among jobs in `rogue/` unless repository evidence shows another meaning.

When dependencies are present:

1. identify the upstream and downstream job IDs
2. describe the order required by the graph
3. distinguish dependency order from template execution order inside a single job

## Step 7: Summarize results clearly

When asked to analyze a job or repository, report:

### Job summary
- job `ID`
- enabled/disabled status
- tags
- dependency summary
- table mappings

### Execution summary
- ordered list of referenced templates
- for each template: ID, type (`sql` or shebang command), short purpose

### Variable summary
- notable Pebble variables and filters used

### Repository summary
- related folders and any generator file such as `nil.nil` that shows how Rogue and template YAML are loaded

## Example output

```text
Job: /migr20/demo-import-kunde
Enabled: true
Tags: migr20-import
Dependencies: none declared

Execution order:
1. /migr20/setup — shebang command (`#!scrat`), adds global template context with `migbank: 20`
2. /migr20/demo-import-kunde — SQL/JDBC export template

Tables:
- src: {{schema}}.VB91_KDPKUNT
- dest: R{{bank | numberformat('000') }}N00G.KDPKUNT

Pebble variables:
- `migrSid`
- `stage | upper`
- `bank | numberformat('000')`
```

## Guardrails

- Read the actual YAML files before summarizing behavior.
- Do not assume every job has all template stages.
- Do not assume templates are SQL when a shebang is present.
- Do not flatten job-level dependencies into template-level sequencing.
- If the repository contains no `rogue/` or `templates/` folder, say so explicitly and stop.
