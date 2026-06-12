export async function resolve(specifier, context, nextResolve) {
	if (
		(specifier.startsWith("./") || specifier.startsWith("../"))
		&& !specifier.endsWith(".ts")
		&& !specifier.endsWith(".js")
		&& !specifier.endsWith(".json")
	) {
		try {
			return await nextResolve(`${specifier}.ts`, context);
		} catch {
			// Fall through to Node's default resolver for directories/packages.
		}
	}
	return nextResolve(specifier, context);
}
