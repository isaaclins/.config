import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PROTOCOL_VERSION = 5;
const FIXTURE_BUNDLE_ID = "com.injaneity.pi-computer-use.fixture";
const FIXTURE_EXECUTABLE = "PiComputerUseFixture";
const FIXTURE_TITLE = "Pi Computer Use Fixture";
const FIXTURE_INPUT = "fixture-input";
const FIXTURE_APPLY = "fixture-apply";
const FIXTURE_STATUS = "fixture-status";
const FIXTURE_VALUE = "integration-ok";
const EXPECTED_STATUS = `Status: applied:${FIXTURE_VALUE}`;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSource = path.join(repositoryRoot, "test-fixtures", "macos", "PiComputerUseFixture.swift");
const launchOnly = process.argv.includes("--launch-only");
const unsupportedArguments = process.argv.slice(2).filter((argument) => argument !== "--launch-only");

if (unsupportedArguments.length > 0) {
	throw new Error(`unsupported arguments: ${unsupportedArguments.join(", ")}`);
}

if (process.platform !== "darwin") {
	console.log("SKIP macOS fixture integration (requires macOS)");
	process.exit(0);
}

if (process.env.PI_CU_FIXTURE_LIVE !== "1") {
	console.log("SKIP macOS fixture integration (set PI_CU_FIXTURE_LIVE=1)");
	process.exit(0);
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-fixture-"));
const appBundle = path.join(temporaryRoot, `${FIXTURE_EXECUTABLE}.app`);
const contentsDirectory = path.join(appBundle, "Contents");
const executableDirectory = path.join(contentsDirectory, "MacOS");
const executablePath = path.join(executableDirectory, FIXTURE_EXECUTABLE);
const socketPath = process.env.PI_CU_SOCKET_PATH ?? path.join(os.homedir(), "Library", "Caches", "pi-computer-use", "bridge.sock");
let fixturePid;
let fixtureProcess;
let preserveFixture = false;

try {
	await buildFixtureApp();
	const diagnostics = await callHelper({ id: requestId("diagnostics"), cmd: "diagnostics" });
	assert(
		diagnostics.protocolVersion === HELPER_PROTOCOL_VERSION,
		`helper protocol mismatch: expected ${HELPER_PROTOCOL_VERSION}, got ${diagnostics.protocolVersion}`,
	);
	assert(diagnostics.accessibility === true, "helper does not have Accessibility permission");
	fixtureProcess = spawn(executablePath, [], {
		cwd: temporaryRoot,
		detached: launchOnly,
		stdio: "ignore",
	});
	fixturePid = fixtureProcess.pid;
	assert(Number.isInteger(fixturePid) && fixturePid > 0, "fixture process did not return a valid pid");
	assertFixtureIsRunning();

	const fixtureApp = await waitFor(
		async () => {
			assertFixtureIsRunning();
			const apps = await callHelper({ id: requestId("apps"), cmd: "listApps" });
			return Array.isArray(apps)
				? apps.find((app) => app?.pid === fixturePid)
				: undefined;
		},
		`fixture process with pid ${fixturePid}`,
		30_000,
	);
	assert(fixtureApp.pid === fixturePid, "helper returned an app other than the exact launched fixture process");
	assertFixtureIsRunning();

	const fixtureRoot = await waitFor(
		async () => {
			const result = await callHelper({ id: requestId("roots"), cmd: "listRoots", pid: fixtureApp.pid });
			const roots = Array.isArray(result?.roots) ? result.roots : [];
			return roots.find((root) => root?.kind === "window" && root?.pid === fixtureApp.pid && root?.title === FIXTURE_TITLE);
		},
		`fixture window titled ${JSON.stringify(FIXTURE_TITLE)}`,
	);
	assert(Number.isInteger(fixtureRoot.windowId) && fixtureRoot.windowId > 0, "fixture root has no usable windowId");
	assert(typeof fixtureRoot.rootRef === "string" && fixtureRoot.rootRef.length > 0, "fixture root has no semantic rootRef");

	if (launchOnly) {
		preserveFixture = true;
		fixtureProcess.unref();
		console.log(JSON.stringify({
			mode: "launch-only",
			pid: fixturePid,
			bundleId: FIXTURE_BUNDLE_ID,
			title: FIXTURE_TITLE,
			appBundle,
			temporaryRoot,
			cleanup: [
				`kill ${fixturePid}`,
				`rm -rf -- ${JSON.stringify(temporaryRoot)}`,
			],
		}, null, 2));
	} else {
		const initialLook = await lookAtFixture(fixtureApp, fixtureRoot);
		const inputNode = findNodeByIdentifier(initialLook.outline, FIXTURE_INPUT);
		assert(inputNode?.canSetValue === true, `fixture input ${FIXTURE_INPUT} is not settable`);
		const setTextResult = await callHelper({
			id: requestId("set-text"),
			cmd: "act",
			lookId: initialLook.lookId,
			pid: fixtureApp.pid,
			target: { ref: inputNode.ref },
			action: "setText",
			params: { text: FIXTURE_VALUE },
			policy: "ax_only",
		});
		assert(setTextResult?.outcome === "worked", `setText did not work: ${JSON.stringify(setTextResult)}`);

		const afterTextLook = await waitFor(
			async () => {
				const look = await lookAtFixture(fixtureApp, fixtureRoot);
				const refreshedInput = findNodeByIdentifier(look.outline, FIXTURE_INPUT);
				return nodeContainsText(refreshedInput, FIXTURE_VALUE) ? look : undefined;
			},
			`fixture input value ${JSON.stringify(FIXTURE_VALUE)}`,
		);
		const applyNode = findNodeByIdentifier(afterTextLook.outline, FIXTURE_APPLY);
		assert(applyNode?.canPress === true, `fixture button ${FIXTURE_APPLY} is not pressable`);
		await callHelper({
			id: requestId("apply"),
			cmd: "act",
			lookId: afterTextLook.lookId,
			pid: fixtureApp.pid,
			target: { ref: applyNode.ref },
			action: "press",
			params: {},
			policy: "ax_only",
		});

		await waitFor(
			async () => {
				const look = await lookAtFixture(fixtureApp, fixtureRoot);
				const statusNode = findNodeByIdentifier(look.outline, FIXTURE_STATUS);
				return nodeContainsText(statusNode, EXPECTED_STATUS) ? statusNode : undefined;
			},
			`fixture status ${JSON.stringify(EXPECTED_STATUS)}`,
		);

		console.log(`PASS macOS fixture integration (protocol ${HELPER_PROTOCOL_VERSION}, pid ${fixtureApp.pid}, status ${JSON.stringify(EXPECTED_STATUS)})`);
	}
} finally {
	if (!preserveFixture) {
		await terminateFixture();
		await fs.rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function buildFixtureApp() {
	await fs.mkdir(executableDirectory, { recursive: true });
	await fs.writeFile(path.join(contentsDirectory, "Info.plist"), infoPlist(), "utf8");
	await run("xcrun", [
		"swiftc",
		"-parse-as-library",
		fixtureSource,
		"-o",
		executablePath,
		"-framework",
		"AppKit",
	]);
	await run("codesign", ["--force", "--sign", "-", "--identifier", FIXTURE_BUNDLE_ID, appBundle]);
}

async function lookAtFixture(fixtureApp, fixtureRoot) {
	assert(fixtureApp.pid === fixturePid, "refusing to observe a process other than the launched fixture");
	const look = await callHelper({
		id: requestId("look"),
		cmd: "look",
		windowId: fixtureRoot.windowId,
		windowRef: fixtureRoot.rootRef,
		readText: "never",
		maxDimension: 1200,
	}, 20_000);
	assert(look?.window?.windowId === fixtureRoot.windowId, "helper returned a different window than the fixture root");
	assert(typeof look.lookId === "string" && look.lookId.length > 0, "fixture look has no freshness token");
	assert(look.outline && typeof look.outline === "object", "fixture look has no semantic outline");
	return look;
}

function findNodeByIdentifier(root, identifier) {
	if (!root || typeof root !== "object") return undefined;
	if (root.identifier === identifier) return root;
	for (const child of Array.isArray(root.children) ? root.children : []) {
		const match = findNodeByIdentifier(child, identifier);
		if (match) return match;
	}
	return undefined;
}

function nodeContainsText(node, expected) {
	if (!node) return false;
	return [node.title, node.description, node.value]
		.filter((value) => typeof value === "string")
		.some((value) => value.includes(expected));
}

function callHelper(payload, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`timed out calling helper command ${payload.cmd}`));
		}, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer);
			socket.end();
			try {
				const response = JSON.parse(buffer.slice(0, newline));
				if (!response.ok) {
					reject(new Error(`${payload.cmd} failed (${response.error?.code ?? "unknown"}): ${response.error?.message ?? "unknown error"}`));
					return;
				}
				resolve(response.result);
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function waitFor(probe, description, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const result = await probe();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await delay(200);
	}
	const suffix = lastError ? `; last error: ${lastError.message}` : "";
	throw new Error(`timed out waiting for ${description}${suffix}`);
}

function assertFixtureIsRunning() {
	if (!fixturePid) {
		throw new Error("fixture process exited before the integration test completed");
	}
	try {
		process.kill(fixturePid, 0);
	} catch {
		throw new Error("fixture process exited before the integration test completed");
	}
}

async function terminateFixture() {
	if (!fixturePid || !processExists(fixturePid)) return;
	process.kill(fixturePid, "SIGTERM");
	if (await waitForExit(fixturePid, 2_000)) return;
	process.kill(fixturePid, "SIGKILL");
	await waitForExit(fixturePid, 2_000);
}

async function waitForExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processExists(pid)) return true;
		await delay(100);
	}
	return !processExists(pid);
}

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim() || stdout.trim()}`));
		});
	});
}

function requestId(label) {
	return `fixture-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function infoPlist() {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>${FIXTURE_EXECUTABLE}</string>
	<key>CFBundleIdentifier</key>
	<string>${FIXTURE_BUNDLE_ID}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${FIXTURE_TITLE}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
`;
}
