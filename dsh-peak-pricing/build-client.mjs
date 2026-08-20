#!/usr/bin/env node
/**
 * 构建 lib/client.js（DSH client module bundle）。
 *
 * 步骤：
 *  1. 读取 src/schedule.js（共享纯逻辑）并剥离 `export ` 前缀；
 *  2. 读取 src/client.template.js（浏览器逻辑）；
 *  3. 拼接后包进 window.__ModuleLoader__.load({ id, factory }) 外壳。
 *
 * 用法：node build-client.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schedulePath = join(here, "src", "schedule.js");
const templatePath = join(here, "src", "client.template.js");
const outPath = join(here, "lib", "client.js");

const PLUGIN_ID = "dsh-peak-pricing";

const schedule = readFileSync(schedulePath, "utf8").replace(/^export\s+/gm, "");
const body = [
  "/* Shared schedule logic generated from src/schedule.js. */",
  schedule,
  readFileSync(templatePath, "utf8"),
].join("\n");

// __ModuleLoader__.load 外壳：id 是插件的 client 导出规范名，factory 返回 module.exports。
const out =
  "window.__ModuleLoader__.load({\n" +
  '\tid: "' + PLUGIN_ID + '",\n' +
  "\tfactory: (require) => {\n" +
  "\t\tvar module = { exports: {} };\n" +
  "\t\tvar exports = module.exports;\n" +
  "\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });\n" +
  body + "\n" +
  "\t\treturn module.exports;\n" +
  "\t}\n" +
  "});\n";

writeFileSync(outPath, out);
console.log("wrote", outPath, "bytes:", Buffer.byteLength(out));
