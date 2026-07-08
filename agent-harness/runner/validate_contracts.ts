// Minimal JSON-Schema validator covering exactly the subset used by ../contracts:
// $ref (#/... pointers), type, enum, pattern, minLength, required, properties,
// additionalProperties (schema form), minProperties, items, minItems.
// Deliberately no external dependency (KISS / no new stack).

import * as fs from "node:fs";
import * as path from "node:path";

export interface SchemaError {
	path: string;
	message: string;
}

function resolveRef(root: unknown, ref: string): unknown {
	if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
	let node: any = root;
	for (const key of ref.slice(2).split("/")) {
		node = node?.[key];
		if (node === undefined) throw new Error(`unresolvable $ref: ${ref}`);
	}
	return node;
}

function typeOf(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

export function validate(schema: any, value: unknown, root: any = schema, at = "$"): SchemaError[] {
	if (schema.$ref) return validate(resolveRef(root, schema.$ref), value, root, at);
	const errors: SchemaError[] = [];
	const err = (message: string) => errors.push({ path: at, message });

	if (schema.type && typeOf(value) !== schema.type) {
		err(`expected ${schema.type}, got ${typeOf(value)}`);
		return errors;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		err(`value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
	}
	if (typeof value === "string") {
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
			err(`"${value}" does not match pattern ${schema.pattern}`);
		}
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			err(`string shorter than minLength ${schema.minLength}`);
		}
	}
	if (typeOf(value) === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in obj)) err(`missing required property "${key}"`);
		}
		if (schema.minProperties !== undefined && Object.keys(obj).length < schema.minProperties) {
			err(`fewer than minProperties ${schema.minProperties}`);
		}
		for (const [key, val] of Object.entries(obj)) {
			const propSchema = schema.properties?.[key];
			if (propSchema) {
				errors.push(...validate(propSchema, val, root, `${at}.${key}`));
			} else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
				errors.push(...validate(schema.additionalProperties, val, root, `${at}.${key}`));
			}
		}
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			err(`fewer than minItems ${schema.minItems}`);
		}
		if (schema.items) {
			value.forEach((item, i) => errors.push(...validate(schema.items, item, root, `${at}[${i}]`)));
		}
	}
	return errors;
}

const CONTRACTS_DIR = path.join(import.meta.dirname, "..", "contracts");

export function validateAgainstContract(contractName: string, value: unknown): SchemaError[] {
	const schema = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, contractName), "utf8"));
	return validate(schema, value);
}

// CLI: node validate_contracts.ts <contract-name.schema.json> <document.json>
if (process.argv[1] === import.meta.filename) {
	const [contract, file] = process.argv.slice(2);
	if (!contract || !file) {
		console.error("usage: node validate_contracts.ts <contract.schema.json> <document.json>");
		process.exit(2);
	}
	const doc = JSON.parse(fs.readFileSync(file, "utf8"));
	const errors = validateAgainstContract(path.basename(contract), doc);
	if (errors.length === 0) {
		console.log(`OK: ${file} satisfies ${contract}`);
	} else {
		for (const e of errors) console.error(`${e.path}: ${e.message}`);
		process.exit(1);
	}
}
