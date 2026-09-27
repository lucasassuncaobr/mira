// Ponte temporária de OCR para a API Go (fase 2).
// Reaproveita tesseract.js + @tesseract.js-data/por já instalados no
// workspace (resolução sobe até Aprova/node_modules). Substituição futura:
// serviço de OCR externo ou engine nativa, sem Node no caminho.
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createWorker, PSM } = require("tesseract.js");
const porData = require("@tesseract.js-data/por").default ?? require("@tesseract.js-data/por");

const dir = process.argv[2];
const files = (await readdir(dir))
  .filter((f) => /^page-\d+\.png$/.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const worker = await createWorker("por", 1, {
  langPath: porData.langPath,
  gzip: porData.gzip,
  cacheMethod: "readOnly",
});
await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: "1" });

const pages = [];
try {
  for (const [index, image] of files.entries()) {
    const buf = await readFile(path.join(dir, image));
    const result = await worker.recognize(buf);
    pages.push(`[[PAGE:${index + 1}]]\n${result.data.text}`);
  }
} finally {
  await worker.terminate();
}
process.stdout.write(JSON.stringify({ text: pages.join("\n") }));
