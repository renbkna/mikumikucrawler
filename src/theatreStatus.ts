export const THEATRE_STATUS_VALUES = [
	"idle",
	"blackout",
	"counting",
	"beam",
	"live",
] as const;

export type TheatreStatus = (typeof THEATRE_STATUS_VALUES)[number];

export function shouldResetTheatreStatus(
	status: TheatreStatus,
	isAttacking: boolean,
): boolean {
	return status !== "idle" && !isAttacking;
}
