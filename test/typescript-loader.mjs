import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";

export async function load(url, context, nextLoad) {
	const parsedUrl = new URL(url);
	if (!parsedUrl.pathname.endsWith(".ts")) return nextLoad(url, context);
	const filePath = fileURLToPath(parsedUrl);
	const source = await readFile(filePath, "utf8");
	const result = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			sourceMap: false,
		},
		fileName: filePath,
	});
	return { format: "module", source: result.outputText, shortCircuit: true };
}
