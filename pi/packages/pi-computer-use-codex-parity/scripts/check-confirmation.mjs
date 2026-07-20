#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ComputerUseConfirmationSession } from "../src/confirmation.ts";

function operation(overrides = {}) {
	return {
		action: "click",
		stateChanging: true,
		target: {
			key: "desktop:com.example.notes:@r1",
			kind: "desktop_root",
			appName: "Notes",
			windowTitle: "Draft",
		},
		...overrides,
	};
}

function makeUI(hasUI = true, response = true) {
	const prompts = [];
	return {
		prompts,
		hasUI,
		async confirm(title, message) {
			prompts.push({ title, message });
			return response;
		},
	};
}

{
	const session = new ComputerUseConfirmationSession();
	const ui = makeUI(false);
	await session.authorize(operation(), "off", ui);
	assert.equal(ui.prompts.length, 0, "off mode must never prompt, including without an interactive UI");
}

{
	const session = new ComputerUseConfirmationSession();
	const ui = makeUI();
	await session.authorize(operation(), "first-use", ui);
	await session.authorize(operation(), "first-use", ui);
	assert.equal(ui.prompts.length, 1, "first-use mode should prompt once per exact target");
	assert.equal(session.isApproved(operation().target.key), true);
	await session.authorize(operation({ target: { ...operation().target, key: "desktop:com.example.notes:@r2", windowTitle: "Second Draft" } }), "first-use", ui);
	assert.equal(ui.prompts.length, 2, "a second root should have an independent first-use confirmation");
	session.reset();
	await session.authorize(operation(), "first-use", ui);
	assert.equal(ui.prompts.length, 3, "session reset should clear first-use approvals");
}

{
	const session = new ComputerUseConfirmationSession();
	const ui = makeUI();
	await session.authorize(operation(), "always", ui);
	await session.authorize(operation(), "always", ui);
	assert.equal(ui.prompts.length, 2, "always mode must prompt for every state-changing action");
	assert.equal(session.isApproved(operation().target.key), false, "always mode should not seed the first-use cache");
}

for (const mode of ["off", "first-use", "always"]) {
	const session = new ComputerUseConfirmationSession();
	const ui = makeUI(false);
	await session.authorize(operation({ stateChanging: false }), mode, ui);
	assert.equal(ui.prompts.length, 0, `read-only operations should not prompt in ${mode} mode`);
}

for (const mode of ["first-use", "always"]) {
	const session = new ComputerUseConfirmationSession();
	const ui = makeUI(false);
	await assert.rejects(() => session.authorize(operation(), mode, ui), /requires an interactive Pi UI/i);
}

{
	const session = new ComputerUseConfirmationSession();
	const ui = makeUI(true, false);
	await assert.rejects(() => session.authorize(operation(), "first-use", ui), /did not approve/i);
	assert.equal(session.isApproved(operation().target.key), false, "declined approval must not be cached");
}

{
	const bridgeSource = readFileSync(new URL("../src/bridge.ts", import.meta.url), "utf8");
	for (const executor of ["executeAct", "executeNavigateBrowser", "executeEvaluateBrowser", "executeLaunchBrowserContext"]) {
		assert.match(bridgeSource, new RegExp(`export const ${executor} = makeConfirmationToolExecutor`), `${executor} must use the confirmation executor`);
	}
	assert.match(bridgeSource, /Browser contexts only support act_ui actions setText and scroll/, "unsupported browser-context actions must be rejected before desktop delivery");
	assert.match(bridgeSource, /Custom CDP ports are not permitted/, "managed browsers must not attach to caller-selected debugger ports");
	assert.match(bridgeSource, /const port = await freeTcpPort\(\)/, "managed browsers must allocate their own debugger port");
	assert.match(bridgeSource, /cdpEvaluateForContext\(contextId, expression\)/, "arbitrary evaluate_browser expressions must execute without content classification");
	assert.doesNotMatch(bridgeSource, /params\.(?:risk|intent)/, "removed policy hints must not remain in bridge operations");

	const cdpSource = readFileSync(new URL("../src/cdp.ts", import.meta.url), "utf8");
	assert.match(cdpSource, /document\.body \? document\.body\.innerText : ''", true\)/, "internal CDP snapshot text reads must reject side effects");

	const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
	assert.match(configSource, /confirmation_mode: "off"/, "confirmation mode must default to off");
	assert.match(configSource, /PI_COMPUTER_USE_CONFIRMATION_MODE/, "confirmation mode must support its environment override");
}

console.log("Computer-use confirmation checks passed.");
