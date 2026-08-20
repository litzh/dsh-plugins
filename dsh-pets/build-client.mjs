#!/usr/bin/env node
/**
 * 构建 lib/client.js（DSH client module bundle）。
 *
 * 步骤：
 *  1. 读取 src/client.template.js（人类可维护的源逻辑）。
 *  2. 把整段包进 window.__ModuleLoader__.load({ id, factory }) 外壳。
 *
 * factory 外壳提供 module / exports / require，与 DSH 发行版里其它 client bundle 一致。
 * 宠物资源不再内联——由 host 半区从 ~/.dsh/pets 动态提供（见 lib/index.js）。
 *
 * 用法：node build-client.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, "src", "client.template.js");
const outPath = join(here, "lib", "client.js");

const PLUGIN_ID = "dsh-pets";

const body = readFileSync(templatePath, "utf8");

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
