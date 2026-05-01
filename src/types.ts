export interface Toast {
	id: number;
	type: "success" | "error" | "info" | "warning";
	message: string;
	timeout: number;
}
