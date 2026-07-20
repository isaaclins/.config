export const CONFIRMATION_MODES = ["off", "first-use", "always"] as const;

export type ConfirmationMode = typeof CONFIRMATION_MODES[number];

export interface ConfirmationTarget {
	key: string;
	appName: string;
	windowTitle?: string;
	kind: "desktop_root" | "browser_page" | "managed_browser";
}

export interface ConfirmationOperation {
	action: string;
	stateChanging: boolean;
	target: ConfirmationTarget;
}

export interface ConfirmationUI {
	hasUI: boolean;
	confirm(title: string, message: string): Promise<boolean>;
}

function targetLabel(target: ConfirmationTarget): string {
	const title = target.windowTitle?.trim();
	return title ? `${target.appName} (${title})` : target.appName;
}

function confirmationCopy(operation: ConfirmationOperation, mode: Exclude<ConfirmationMode, "off">): { title: string; message: string } {
	const scope = mode === "first-use"
		? "Allow computer use for this exact app root or browser target during the current Pi session?"
		: "Allow this computer-use action now?";
	return {
		title: mode === "first-use" ? "Allow computer control?" : "Confirm computer-use action",
		message: `Destination: ${targetLabel(operation.target)}\nEffect: ${operation.action.replace(/_/g, " ")}\n\n${scope}`,
	};
}

export class ComputerUseConfirmationSession {
	private readonly approvedTargetKeys = new Set<string>();

	reset(): void {
		this.approvedTargetKeys.clear();
	}

	isApproved(targetKey: string): boolean {
		return this.approvedTargetKeys.has(targetKey);
	}

	async authorize(operation: ConfirmationOperation, mode: ConfirmationMode, ui: ConfirmationUI): Promise<void> {
		if (!operation.stateChanging || mode === "off") return;
		if (mode === "first-use" && this.approvedTargetKeys.has(operation.target.key)) return;
		if (!ui.hasUI) {
			throw new Error(`Computer-use confirmation mode '${mode}' requires an interactive Pi UI.`);
		}
		const copy = confirmationCopy(operation, mode);
		const approved = await ui.confirm(copy.title, copy.message);
		if (!approved) throw new Error("Computer-use action was cancelled because the user did not approve it.");
		if (mode === "first-use") this.approvedTargetKeys.add(operation.target.key);
	}
}
