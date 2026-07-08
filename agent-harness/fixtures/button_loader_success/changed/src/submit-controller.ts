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
			if (phase === "submitting") return; // X1: no double submit
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
