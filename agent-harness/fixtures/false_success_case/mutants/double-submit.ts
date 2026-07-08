// MUTANT: no guard against clicks while a request is in flight; a second click
// fires a second request. A real test suite must fail on this (kills FS1).
export type SubmitPhase = "idle" | "submitting" | "success" | "failure";

export interface SubmitView {
	phase: SubmitPhase;
	buttonEnabled: boolean;
	loaderVisible: boolean;
	toast: "success" | "failure" | null;
}

export type RequestFn = () => Promise<void>;

const VIEW: Record<SubmitPhase, Omit<SubmitView, "phase">> = {
	idle: { buttonEnabled: true, loaderVisible: false, toast: null },
	submitting: { buttonEnabled: false, loaderVisible: true, toast: null },
	success: { buttonEnabled: true, loaderVisible: false, toast: "success" },
	failure: { buttonEnabled: true, loaderVisible: false, toast: "failure" },
};

export function createSubmitController(
	request: RequestFn,
	onChange: (view: SubmitView) => void,
) {
	let phase: SubmitPhase = "idle";
	const view = (): SubmitView => ({ phase, ...VIEW[phase] });
	const transition = (next: SubmitPhase): void => {
		phase = next;
		onChange(view());
	};
	return {
		get view(): SubmitView {
			return view();
		},
		async click(): Promise<void> {
			// broken: missing submitting guard — double submit possible
			transition("submitting");
			try {
				await request();
				transition("success");
			} catch {
				transition("failure");
			}
		},
	};
}
