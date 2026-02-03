# ccs-condition-linter

A linter and diagnostic tool for **Oracle Communication Cloud Service (CCS)** JSONPath conditions.

This tool explains **why** a condition fails (missing paths, wrong types, string-vs-number issues, object vs array filters) and suggests safer rewrites before CCS throws a 500.

## What it does

- Validates CCS-style JSONPath conditions
- Explains `empty true / empty false`
- Detects missing or mis-shaped paths
- Flags string values used in numeric comparisons
- Warns when filters are applied to objects instead of arrays
- Suggests safer rewrites (scalar vs node-set, regex, etc.)

**It does not execute CCS or assemble documents.**  
It is a **lint + diagnostics** tool only.

## Requirements

- **Node.js v18 or newer**

Check:
```bash
node --version
````

## Install Node.js

### Windows

1. Go to [https://nodejs.org](https://nodejs.org)
2. Download **LTS**
3. Run the installer
4. Restart your terminal

### macOS

* Installer: [https://nodejs.org](https://nodejs.org) (LTS), or
* Homebrew:

```bash
brew install node
```

### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install nodejs npm
```

If version is < 18:

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install nodejs
```

## Setup

From the project directory:

```bash
npm install
chmod +x ccs-condition-linter.js   # macOS / Linux only
```

## Usage

### Basic

```bash
./ccs-condition-linter.js --condition '<CONDITION>' --input <file.json>
```

### Example

```bash
./ccs-condition-linter.js \
  --condition '$[?(@.documentid == "ESOTERIC_BILL_IDENTIFIER" && @.some.nested.value < 0)]' \
  --input test.json
```

### Windows (PowerShell)

```powershell
node ccs-condition-linter.js --condition "$[?(@.documentid == `"ESOTERIC_BILL_IDENTIFIER`")]" --input test.json
```

> **Tip (macOS/Linux):**
> Always wrap conditions in **single quotes**.
> JSONPath contains `$[]<>?` which shells love to mangle.


## What you’ll see

* Per-clause TRUE / FALSE results
* Exact path where resolution fails
* Type mismatches (object vs array, string vs number)
* Suggestions for safer rewrites when applicable

Example run:
```
% ./ccs-condition-linter.js --condition '$[?(@.documentid == "ESOTERIC_BILL_IDENTIFIER" && @.some.nested.value != null && @.some.nested.value < 0)]' --input test.json --suggest
Condition group(s):
Group 1 (AND all of):
  1.1. @.documentid == "ESOTERIC_BILL_IDENTIFIER"
  1.2. @.some.nested.value != null
  1.3. @.some.nested.value < 0

Parsing "test.json"...
Group 1 Clause 1.1: TRUE (values=["ESOTERIC_BILL_IDENTIFIER"])
Group 1 Clause 1.2: TRUE (values=["-3998.50"])
Group 1 Clause 1.3: FALSE (values=["-3998.50"])
  Suggestion: the field value(s) look numeric but are strings, so "< 0" won’t evaluate as a numeric compare.
  Example value(s): ["-3998.50"]
  Options:
   - Convert the JSON upstream so value is a number (no quotes).
Group 1 result: FALSE

Overall condition is FALSE.
```


## Common gotchas

### Shell errors (`zsh`, `bash`)

You forgot single quotes.

```bash
--condition '$[?(...)]'
```

### Numeric comparisons always fail

Your JSON has:

```json
"value": "-3998.50"
```

That’s a **string**, not a number.
Either convert upstream or use a string-safe test (regex).

## Why this exists
CCS doesn't tell you why a condition did or did not work, and there's no testing/evaluation tool, so the gap has been filled now.
