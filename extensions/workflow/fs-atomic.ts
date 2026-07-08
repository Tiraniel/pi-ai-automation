// Atomic file writes for durable workflow artifacts (manifests, memos,
// sidecars, plan records). Readers of these files poll or re-read them from
// other flows (finalization, pane status), so a torn read of a half-written
// file must be impossible: write to a tmp file in the same directory, then
// rename over the target.

import * as fs from "node:fs";
import * as path from "node:path";

let tmpCounter = 0;

function tmpPathFor(filePath: string): string {
	tmpCounter += 1;
	return `${filePath}.${process.pid}.${tmpCounter}.tmp`;
}

export function writeFileAtomicSync(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = tmpPathFor(filePath);
	try {
		fs.writeFileSync(tmp, content, "utf8");
		fs.renameSync(tmp, filePath);
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best effort tmp cleanup
		}
		throw error;
	}
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = tmpPathFor(filePath);
	try {
		await fs.promises.writeFile(tmp, content, "utf8");
		await fs.promises.rename(tmp, filePath);
	} catch (error) {
		try {
			await fs.promises.rm(tmp, { force: true });
		} catch {
			// best effort tmp cleanup
		}
		throw error;
	}
}
