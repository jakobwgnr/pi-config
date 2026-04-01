---
name: adamms
description: Practical ADAMMS CLI usage guide for checking auth/context and working with projects, systems, tables, fields, rules, config items, and CSV analysis.
---

# ADAMMS CLI

Use this skill when you need to inspect or update ADAMMS through the CLI. Keep it practical: confirm access, confirm context, then run the command for the task.

Prefer the default JSON output. Use `--pretty` only when a human-readable view is specifically useful.

## Typical CLI Flow

### 1) Check the available CLI commands
```bash
npx adamms --agent-help
```

### 2) Check whether you are authenticated
```bash
adamms auth whoami
```

If needed:
```bash
adamms config set base-url <URL>
adamms auth --email <email> --password <password>
```

### 3) Check whether context is set
```bash
adamms context show
```

If the required project or system is not active:
```bash
adamms context set --project <projectId> --system <systemId>
```

Many commands use the active project or system when IDs are omitted.

### 4) Perform the task
Use the command group that matches the work you need to do.

## Source vs Target Notes

When working inside a project:
- use `--source` to inspect the source system of the active project
- use `--target` to inspect the target system of the active project
- if you need a specific system active, set context explicitly with `adamms context set --project <projectId> --system <systemId>`

Typical source-side commands:
- `adamms tables list --source`
- `adamms fields list --source`
- `adamms fields list --source --table-id <id>`
- `adamms field-values list --field-id <id>`

Typical target-side commands:
- `adamms tables list --target`
- `adamms fields list --target`
- `adamms fields list --target --table-id <id>`
- `adamms rules list`
- `adamms rules get <id>`

## Command Reference

### Projects
- List: `adamms projects list [--user-id <id>]`
- Get: `adamms projects get <id>`
- Create: `adamms projects create --name <name> [--source-system <id>] [--target-system <id>]`
- Update: `adamms projects update <id> [--name <name>] [--source-system <id>] [--target-system <id>]`
- Delete: `adamms projects delete <id>`

### Systems
- List: `adamms systems list [--user-id <id>]`
- Get: `adamms systems get <id>`
- Create: `adamms systems create --name <name> [--type Source|Target]`
- Update: `adamms systems update <id> [--name <name>] [--type Source|Target]`
- Delete: `adamms systems delete <id>`

### Tables
- List: `adamms tables list [--system-id <id>] [--source] [--target] [--filter <value>]`
- Get: `adamms tables get <id>`
- Create: `adamms tables create --system-id <id> --name <name> [--description <desc>] [--functional-area <area>] [--sub-area <area>] [--relevant-for-migration|--no-relevant-for-migration]`
- Update: `adamms tables update <id> [--name <name>] [--description <desc>] [--functional-area <area>] [--sub-area <area>] [--relevant-for-migration|--no-relevant-for-migration]`
- Delete: `adamms tables delete <id>`

### Fields
- List: `adamms fields list [--system-id <id>] [--table-id <id>] [--source] [--target] [--filter <value>]`
- Get: `adamms fields get <id>`
- Create: `adamms fields create --system-id <id> --tablename <t> --fieldname <f> [--datatype <type>] [--length <n>] [--column-number <n>] [--decimal-length <n>] [--nullable|--no-nullable] [--default-value <v>] [--table-id <id>] [--description <desc>] [--validation-code <code>]`
- Update: `adamms fields update <id> [--tablename <t>] [--fieldname <f>] [--datatype <type>] [--length <n>] [--column-number <n>] [--decimal-length <n>] [--nullable|--no-nullable] [--default-value <v>] [--table-id <id>] [--description <desc>] [--validation-code <code>]`
- Delete: `adamms fields delete <id>`

### Field values
- List: `adamms field-values list --field-id <id>`
- Get: `adamms field-values get <id>`
- Create: `adamms field-values create --field-id <id> --value <v> --meaning <m>`
- Update: `adamms field-values update <id> [--value <v>] [--meaning <m>]`
- Delete: `adamms field-values delete <id>`

### Rules
- List: `adamms rules list [--project-id <id>] [--filter <value>]`
- Get: `adamms rules get <id>`
- Create: `adamms rules create --project-id <id> --target-table <t> --mapping-code <code> --status <status> --comment <comment> [--target-field <f>] [--validation-code <code>] [--type FieldMapping|SelectionRule] [--description <d>] [--functional-area <area>] [--sub-area <area>] [--complexity High|Medium|Low] [--priority High|Medium|Low] [--selection-rule-id <id>] [--ticket-id <id>]`
- Update: `adamms rules update <id> --comment <comment> [--status <s>] [--target-table <t>] [--target-field <f>] [--mapping-code <code>] [--validation-code <code>] [--type FieldMapping|SelectionRule] [--description <d>] [--functional-area <area>] [--sub-area <area>] [--complexity High|Medium|Low] [--priority High|Medium|Low] [--selection-rule-id <id>] [--ticket-id <id>]`
- Delete: `adamms rules delete <id>`

Always provide `--comment` when creating or updating rules.

### Config items
- List: `adamms config-items list [--project-id <id>] [--category Global|Local] [--filter <value>]`
- Get: `adamms config-items get <id>`
- Create: `adamms config-items create --name <n> --value <v> --category Global|Local [--project-id <id>] [--description <desc>] [--type <type>] [--comment <comment>]`
- Update: `adamms config-items update <id> [--name <n>] [--value <v>] [--description <desc>] [--type <type>] [--comment <comment>]`
- Delete: `adamms config-items delete <id>`

### CSV analyse
```bash
adamms analyse -i <csv-path> [-o <output-path>]
```

Use this to inspect CSV columns for datatypes, patterns, value lists, and validation-code hints. It does not require server auth.

## Global Options

- `--base-url <url>`, `-b`
- `--token <token>`, `-t`
- `--pretty`
- `--help`, `-h`
- `--agent-help`, `-ah`

## Errors

Responses are JSON.
- success: `{ "data": ... }`
- error: `{ "error": { ... } }`

Common error codes:
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `MISSING_PARAM`
- `BAD_REQUEST`
- `INTERNAL_ERROR`
