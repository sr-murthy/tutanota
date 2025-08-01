/**
 * Build script for android app.
 *
 *  Besides options below this script may require signing parameters passed as environment variables:
 *  'APK_SIGN_ALIAS'
 *  'APK_SIGN_STORE_PASS'
 *  'APK_SIGN_KEY_PASS'
 *  'APK_SIGN_STORE'
 *  'ANDROID_HOME'
 */
import { Argument, Option, program } from "commander"
import { runDevBuild } from "./buildSrc/DevBuild.js"
import { prepareMobileBuild } from "./buildSrc/prepareMobileBuild.js"
import { buildWebapp } from "./buildSrc/buildWebapp.js"
import { getTutanotaAppVersion, measure } from "./buildSrc/buildUtils.js"
import path from "node:path"
import { $, cd } from "zx"

const log = (...messages) => console.log(chalk.green("\nBUILD:"), ...messages, "\n")

await program
	.usage("[options] [test|prod|local|host <url>] ")
	.addArgument(
		new Argument("stage", "the server to connect to. test/local/prod are shorthands for using host <url> of the corresponding staging level server")
			.choices(["test", "prod", "local", "host"])
			.default("prod")
			.argOptional(),
	)
	.addArgument(new Argument("host").argOptional())
	.addOption(new Option("-a, --app <type>", "app to build").choices(["mail", "calendar"]).default("mail"))
	.addOption(
		new Option(
			"-b, --buildtype <type>",
			"gradle build type. use debug if you need to debug the app with android studio. release and releaseTest build the same app with different appIds for side-by-side installation",
		)
			.choices(["debug", "release", "releaseTest"])
			.default("release"),
	)
	.addOption(new Option("-i, --install", "call adb install after build to deploy the app to a device/emulator"))
	.addOption(
		new Option(
			"-w --webclient <client>",
			"choose web client build. make is faster and easier to debug, but dist is what would be running in production. There's usually no reason to use dist during development.",
		)
			.choices(["make", "dist"])
			.default("dist"),
	)
	.option("-e, --existing", "Use existing prebuilt web client files to skip the lengthy web client build. Use if you're developing the Kotlin code.")
	.action(async (stage, host, { webclient, buildtype, install, existing, app }) => {
		if ((stage === "host" && host == null) || (stage !== "host" && host != null)) {
			program.outputHelp()
			process.exit(1)
		}

		const apk = await buildAndroid({
			stage: stage ?? "prod",
			host: host,
			webClient: webclient,
			existing,
			buildType: buildtype,
			app,
		})

		if (install) {
			await $`adb install ${apk}`
			// would be cool to auto-start the app, but needs to figure out the correct app to start:
			// await $`adb shell am start -n de.tutao.tutanota/de.tutao.tutanota.MainActivity`
		}
	})
	.parseAsync(process.argv)

async function buildCalendarBundle({ buildType }) {
	const { version } = JSON.parse(await $`cat package.json`.quiet())

	const bundleName = `calendar-tutao-${buildType}-${version}.aab`
	const bundlePath = `app-android/calendar/build/outputs/bundle/tutao${buildType.charAt(0).toUpperCase() + buildType.slice(1)}/${bundleName}`
	const outPath = `./build-calendar-app/app-android/${bundleName}`

	cd("./app-android")

	await $`./gradlew :calendar:bundleTutao${buildType}`

	cd("..")

	await $`mkdir -p build-calendar-app/app-android`
	await $`mv ${bundlePath} ${outPath}`

	log(`Build complete. The AAB is located at: ${outPath}`)

	return outPath
}

async function buildCalendarApk({ buildType }) {
	const { version } = JSON.parse(await $`cat package.json`.quiet())

	const bundleName = `calendar-tutao-${buildType}-${version}`
	const bundlePath = `app-android/calendar/build/outputs/apk/tutao/${buildType}/${bundleName}`
	const outPath = `./build-calendar-app/app-android/${bundleName}`

	cd("./app-android")

	await $`if [ -f .${outPath}.aab ]; then mkdir ../temp; mv .${outPath}.aab ../temp/${bundleName}.aab; fi`

	await $`./gradlew :calendar:assembleTutao${buildType}`

	cd("..")

	await $`mkdir -p build-calendar-app/app-android`
	await $`mv ${bundlePath}.apk ${outPath}.apk`

	await $`if [ -f ./temp/${bundleName}.aab ]; then mv ./temp/${bundleName}.aab ${outPath}.aab; rm -d ./temp; fi`

	log(`Build complete. The APK is located at: ${outPath}`)

	return outPath
}

async function buildMailApk({ buildType }) {
	const { version } = JSON.parse(await $`cat package.json`.quiet())
	const apkName = `tutanota-app-tutao-${buildType}-${version}.apk`
	const apkPath = `app-android/app/build/outputs/apk/tutao/${buildType}/${apkName}`

	const outPath = `./build/app-android/${apkName}`

	cd("./app-android")
	await $`./gradlew :app:assembleTutao${buildType}`

	cd("..")
	await $`mkdir -p build/app-android`
	await $`mv ${apkPath} ${outPath}`

	log(`Build complete. The APK is located at: ${outPath}`)

	return outPath
}

async function buildAndroid({ stage, host, buildType, existing, webClient, app }) {
	log(`Starting ${stage} build with build type: ${buildType}, webclient: ${webClient}, host: ${host}`)

	if (!existing) {
		if (webClient === "make") {
			await runDevBuild({
				stage,
				host,
				desktop: false,
				clean: false,
				watch: false,
				serve: false,
				networkDebugging: false,
				app,
			})
		} else {
			const version = await getTutanotaAppVersion()
			await buildWebapp({
				version,
				stage,
				host,
				minify: true,
				projectDir: path.resolve("."),
				measure,
				app,
			})
		}
	} else {
		console.log("skipped webapp build")
	}

	await prepareMobileBuild({ app })
	const buildDir = app === "mail" ? "build" : "build-calendar-app"
	try {
		await $`rm -r ${buildDir}/app-android`
	} catch (e) {
		// Ignoring the error if the folder is not there
	}

	if (app === "mail") {
		return await buildMailApk({ buildType })
	} else {
		await buildCalendarBundle({ buildType })
		return await buildCalendarApk({ buildType })
	}
}
