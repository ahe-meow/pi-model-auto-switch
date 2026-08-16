import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

export async function load(url, context, nextLoad) {
	if (!url.endsWith(".ts")) return nextLoad(url, context);
	const source = await readFile(fileURLToPath(url), "utf8");
	const result = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			sourceMap: false,
		},
		fileName: fileURLToPath(url),
	});
	return { format: "module", source: result.outputText, shortCircuit: true };
}
