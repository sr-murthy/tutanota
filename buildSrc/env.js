/** @param {{staticUrl: string | null, version: string, mode: EnvMode | null, dist: boolean, domainConfigs: DomainConfigMap, networkDebugging:boolean, clientName?: string}} params
 *  @return {env}
 */
export function create(params) {
	const { staticUrl, version, mode, dist, domainConfigs, networkDebugging, clientName } = params

	if (version == null || mode == null || dist == null || networkDebugging == null) {
		throw new Error(`Invalid env parameters: ${JSON.stringify(params)}`)
	}
	return {
		staticUrl: staticUrl?.toString(),
		versionNumber: version,
		dist,
		mode: mode ?? "Browser",
		timeout: 20000,
		domainConfigs,
		platformId: null,
		networkDebugging,
		clientName,
	}
}

/** @param {env} env */
export function preludeEnvPlugin(env) {
	return {
		name: "prelude-env",
		banner() {
			return `globalThis.env = ${JSON.stringify(env, null, 2)};`
		},
	}
}
