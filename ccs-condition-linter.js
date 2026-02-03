#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const { JSONPath } = require("jsonpath-plus");

/**
 * SUPER pragmatic CCS-ish condition evaluator:
 * - Expects a condition shaped like: $[?( ... )]
 * - Supports top-level && chaining
 * - Supports postfix: "<jsonpath> empty true|false"
 * - Supports scalar: "<jsonpath> == 'x'" and "!= 'x'" and "< 0", "<= 0", "> 0", ">= 0"
 *
 * Notes:
 * - Inside the predicate, we treat @ as "root record", so we rewrite leading @ to $ for jsonpath-plus.
 * - We forbid mixing $ and @ in the predicate; use @ only (like CCS wants).
 */

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.error(
    `Usage:
  node ccs-cond.js --condition "<JSONPath condition>" --input <file.json>

Example:
  node ccs-cond.js --condition "$[?(@.documentid == 'CO-G1-CO18' && @.billPrint.billDetails[?(@.currPayAmt < 0)] empty false)]" --input input.json`
  );
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function parseExpressionToOrAndGroups(expr) {
  const orGroups = splitTopLevelByOperator(expr, "||");
  return orGroups.map((g) => splitTopLevelByOperator(g, "&&"));
}

function unwrapCondition(cond) {
  const s = cond.trim();
  // Allow passing either "$[?(...)]" or just "[?(...)]" or just "(...)"
  if (s.startsWith("$[?(") && s.endsWith(")]")) return s.slice(4, -2).trim(); // inside ?( ... )
  if (s.startsWith("[?(") && s.endsWith(")]")) return s.slice(3, -2).trim();
  if (s.startsWith("(") && s.endsWith(")")) return s.slice(1, -1).trim();
  return s;
}
function splitTopLevelByOperator(expr, op) {
  // op must be "&&" or "||"
  const parts = [];
  let buf = "";
  let paren = 0;
  let bracket = 0;
  let inQuote = false;
  let quoteChar = null;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    const next = expr[i + 1];

    if (inQuote) {
      buf += ch;
      if (ch === quoteChar && expr[i - 1] !== "\\") {
        inQuote = false;
        quoteChar = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inQuote = true;
      quoteChar = ch;
      buf += ch;
      continue;
    }

    if (ch === "(") paren++;
    if (ch === ")") paren--;
    if (ch === "[") bracket++;
    if (ch === "]") bracket--;

    if (ch === op[0] && next === op[1] && paren === 0 && bracket === 0) {
      parts.push(buf.trim());
      buf = "";
      i++; // skip second char
      continue;
    }

    buf += ch;
  }

  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}
function splitTopLevelAnd(expr) {
  // split on && but only at top level (not inside (...) or [...] )
  const parts = [];
  let buf = "";
  let paren = 0;
  let bracket = 0;
  let inQuote = false;
  let quoteChar = null;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    const next = expr[i + 1];

    if (inQuote) {
      buf += ch;
      if (ch === quoteChar && expr[i - 1] !== "\\") {
        inQuote = false;
        quoteChar = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inQuote = true;
      quoteChar = ch;
      buf += ch;
      continue;
    }

    if (ch === "(") paren++;
    if (ch === ")") paren--;
    if (ch === "[") bracket++;
    if (ch === "]") bracket--;

    if (ch === "&" && next === "&" && paren === 0 && bracket === 0) {
      parts.push(buf.trim());
      buf = "";
      i++; // skip second &
      continue;
    }

    buf += ch;
  }

  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

function rewriteAtToDollar(path) {
  // CCS uses @.foo inside predicate; jsonpath-plus wants $.
  // Also CCS sometimes uses @.. recursive descent; fine.
  return path.replace(/^@/, "$");
}
function isNumericString(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  // allows "-3998.50", "0", "12.3" (no commas)
  return /^-?\d+(\.\d+)?$/.test(s);
}

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object", "string", "number", "boolean", "undefined"
}

// A very simple segment tokenizer for paths like:
// @.billPrint.billDetails.currPayAmt
// @.premList[0].saList[0].foo
function splitPathSegments(path) {
  const p = path.trim().replace(/^@/, ""); // remove leading @
  // remove leading dot if present
  const clean = p.startsWith(".") ? p.slice(1) : p;
  // split by dots but keep bracket parts with the token
  // e.g. "premList[0]" stays together
  return clean.split(".").filter(Boolean);
}

function segmentToJsonPath(prefixDollar, seg) {
  // seg may be like: "premList[0]" or "billDetails"
  return `${prefixDollar}.${seg}`;
}

/**
 * Diagnose where a deep path stops resolving.
 * Works best for "simple" deep paths (no filters) like:
 *   @.billPrint.billDetails.currPayAmt
 */
function diagnoseDeepPath(deepPath, json) {
  const segments = splitPathSegments(deepPath);
  const out = [];
  let prefix = "$";

  for (let i = 0; i < segments.length; i++) {
    prefix = segmentToJsonPath(prefix, segments[i]);

    let vals = [];
    try {
      vals = JSONPath({ path: prefix, json, wrap: true });
    } catch (e) {
      out.push({
        path: prefix,
        status: "ERROR",
        detail: `JSONPath parse error at segment "${segments[i]}": ${e.message}`,
      });
      break;
    }

    if (!vals || vals.length === 0) {
      out.push({
        path: prefix,
        status: "MISSING",
        detail: "No nodes returned (missing path or wrong structure).",
      });
      break;
    }

    // Usually a single node at each step; if multiple, summarize.
    const sample = vals.slice(0, 3);
    const types = [...new Set(sample.map(typeName))];
    out.push({
      path: prefix,
      status: "OK",
      detail: `nodeCount=${vals.length}, sampleTypes=${types.join(", ")}, sample=${previewList(vals, 3)}`,
    });

    // If we hit a primitive but still have segments to traverse, call it out
    if (i < segments.length - 1) {
      const t = typeName(sample[0]);
      if (t !== "object" && t !== "array") {
        out.push({
          path: prefix,
          status: "STOP",
          detail: `Value is ${t}, so it cannot have child "${segments[i + 1]}".`,
        });
        break;
      }
    }
  }

  return out;
}

/**
 * Best-effort “base path” extractor for an empty-clause like:
 *   @.billPrint.billDetails[?(@.currPayAmt < 0)] empty false
 * Returns:
 *   basePath = @.billPrint.billDetails
 *   predicate = @.currPayAmt < 0
 */
function splitFilterBaseAndPredicate(pathWithFilter) {
  const m = pathWithFilter.match(/^(.*)\[\?\((.*)\)\]\s*$/);
  if (!m) return null;
  return { basePath: m[1].trim(), predicate: m[2].trim() };
}

function evalJsonPath(path, json) {
  const p = rewriteAtToDollar(path);
  return JSONPath({ path: p, json, wrap: true });
}


function getSingleTypeAtPath(path, json) {
  const vals = evalJsonPath(path, json);
  if (!vals || vals.length === 0) return null;
  return typeName(vals[0]);
}

function parseEmptyClause(clause) {
  // matches: "<path> empty true|false"
  const m = clause.match(/^(.*)\s+empty\s+(true|false)\s*$/i);
  if (!m) return null;
  return { path: m[1].trim(), wantEmpty: m[2].toLowerCase() === "true" };
}

function parseCompareClause(clause) {
  // supports ==, !=, <, <=, >, >= against number or quoted string or null
  const m = clause.match(/^(.*?)\s*(==|!=|<=|>=|<|>)\s*(.*?)\s*$/);
  if (!m) return null;
  const left = m[1].trim();
  const op = m[2];
  const rightRaw = m[3].trim();

  let right;
  if ((rightRaw.startsWith("'") && rightRaw.endsWith("'")) || (rightRaw.startsWith('"') && rightRaw.endsWith('"'))) {
    right = rightRaw.slice(1, -1);
  } else if (rightRaw.toLowerCase() === "null") {
    right = null;
  } else if (!Number.isNaN(Number(rightRaw))) {
    right = Number(rightRaw);
  } else {
    // fallback: treat as bare string
    right = rightRaw;
  }

  return { left, op, right, rightRaw };
}

function truncateString(s, max = 160) {
  if (typeof s !== "string") return s;
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max} chars)`;
}

function previewValue(v, opts = {}) {
  const {
    maxString = 160,
    maxKeys = 12,
    maxArrayItems = 5,
    maxDepth = 2,
  } = opts;

  const t = typeName(v);

  if (t === "string") return `"${truncateString(v, maxString)}"`;
  if (t === "number" || t === "boolean" || t === "null" || t === "undefined") return String(v);

  // arrays
  if (t === "array") {
    const arr = v;
    const head = arr.slice(0, maxArrayItems).map((x) =>
      maxDepth > 0 ? previewValue(x, { ...opts, maxDepth: maxDepth - 1 }) : typeName(x)
    );
    const more = arr.length > maxArrayItems ? `…(+${arr.length - maxArrayItems} more)` : "";
    return `[${head.join(", ")}${more ? ", " + more : ""}] (len=${arr.length})`;
  }

  // objects
  if (t === "object") {
    const keys = Object.keys(v);
    const shown = keys.slice(0, maxKeys);
    const more = keys.length > maxKeys ? `…(+${keys.length - maxKeys} keys)` : "";
    return `{${shown.join(", ")}${more ? ", " + more : ""}}`;
  }

  return String(v);
}

function previewList(values, limit = 3, opts = {}) {
  const sample = values.slice(0, limit).map((v) => previewValue(v, opts));
  const more = values.length > limit ? `…(+${values.length - limit} more)` : "";
  return `[${sample.join(", ")}${more ? ", " + more : ""}]`;
}


function compareAny(values, op, right) {
  // JSONPath can return multiple values; CCS effectively treats this as “any match”.
  for (const v of values) {
    switch (op) {
      case "==":
        if (v === right) return true;
        break;
      case "!=":
        if (v !== right) return true;
        break;
      case "<":
        if (typeof v === "number" && typeof right === "number" && v < right) return true;
        break;
      case "<=":
        if (typeof v === "number" && typeof right === "number" && v <= right) return true;
        break;
      case ">":
        if (typeof v === "number" && typeof right === "number" && v > right) return true;
        break;
      case ">=":
        if (typeof v === "number" && typeof right === "number" && v >= right) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

function describeClause(clause) {
  const empty = parseEmptyClause(clause);
  if (empty) {
    return `${empty.path} is ${empty.wantEmpty ? "EMPTY" : "NOT EMPTY"}`;
  }
  const cmp = parseCompareClause(clause);
  if (cmp) {
    return `${cmp.left} ${cmp.op} ${cmp.rightRaw}`;
  }
  return clause;
}

function main() {
  const condition = arg("--condition");
  const input = arg("--input");
  if (!condition || !input) usageAndExit("Missing --condition or --input.");

  const raw = fs.readFileSync(input, "utf8");
  const json = JSON.parse(raw);

  const expr = unwrapCondition(condition);

  // quick CCS parser safety check: discourage $ inside predicate
  if (expr.includes("$.")) {
    console.error("Warning: found '$.' inside predicate. CCS often chokes on this. Prefer '@.' inside predicates.");
  }

  const groups = parseExpressionToOrAndGroups(expr);

// Pretty print
console.log("Condition group(s):");
groups.forEach((clauses, gi) => {
  console.log(`Group ${gi + 1} (AND all of):`);
  clauses.forEach((c, ci) => {
    console.log(`  ${gi + 1}.${ci + 1}. ${describeClause(c)}`);
  });
});

console.log(`\nParsing "${input}"...`);

let overall = false;

groups.forEach((clauses, gi) => {
  let groupOk = true;

  clauses.forEach((clause, ci) => {
    let ok = false;

    const empty = parseEmptyClause(clause);
    if (empty) {
      const results = evalJsonPath(empty.path, json);
      const isEmpty = results.length === 0;
      ok = empty.wantEmpty ? isEmpty : !isEmpty;

      console.log(
        `Group ${gi + 1} Clause ${gi + 1}.${ci + 1}: ${ok ? "TRUE" : "FALSE"} (nodeCount=${results.length}, wantEmpty=${empty.wantEmpty})`
      );

      // keep your diagnostics block here if you added it
      // (you can paste it right under this print)
    } else {
      const cmp = parseCompareClause(clause);
      if (!cmp) {
        console.log(`Group ${gi + 1} Clause ${gi + 1}.${ci + 1}: ERROR (unsupported clause syntax) -> ${clause}`);
        ok = false;
      } else {
        const values = evalJsonPath(cmp.left, json);
        ok = compareAny(values, cmp.op, cmp.right);
        console.log(`Group ${gi + 1} Clause ${gi + 1}.${ci + 1}: ${ok ? "TRUE" : "FALSE"} (values=${previewList(values, 5, { maxString: 80 })})`);
        // Suggestions for numeric comparisons that fail due to string-typed values
        if (!ok && ["<", "<=", ">", ">="].includes(cmp.op)) {
          const sample = values.slice(0, 10);
          const hasNumber = sample.some((v) => typeof v === "number");
          const numericStrings = sample.filter(isNumericString);

          if (!hasNumber && numericStrings.length > 0) {
            console.log(`  Suggestion: the field value(s) look numeric but are strings, so "${cmp.op} ${cmp.rightRaw}" won’t evaluate as a numeric compare.`);
            console.log(`  Example value(s): ${previewList(numericStrings, 5, { maxString: 40 })}`);
            console.log(`  Options:`);
            console.log(`   - If CCS supports regex: use something like "@.currPayAmt =~ /^-/" to detect negatives. It probably does not suppor this, so...`);
            console.log(`   - Or convert the JSON upstream so currPayAmt is a number (no quotes).`);            
          }
        }
      }
    }

    groupOk = groupOk && ok;
  });

  console.log(`Group ${gi + 1} result: ${groupOk ? "TRUE" : "FALSE"}\n`);
  overall = overall || groupOk;
});

console.log(`Overall condition is ${overall ? "TRUE" : "FALSE"}.\n`);
process.exit(overall ? 0 : 1);
}

main();

