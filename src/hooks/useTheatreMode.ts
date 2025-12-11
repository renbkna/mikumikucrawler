import { useCallback, useState } from "react";

export type TheatreStatus = "idle" | "blackout" | "counting" | "beam" | "live";

export interface UseTheatreModeReturn {
	theatreStatus: TheatreStatus;
	isUIHidden: boolean;
	startTheatre: (skipAnimation?: boolean) => void;
	handleBeamStart: () => void;
	handleTheatreComplete: () => void;
	resetTheatre: () => void;
}

export function useTheatreMode(): UseTheatreModeReturn {
	const [theatreStatus, setTheatreStatus] = useState<TheatreStatus>("idle");

	const isUIHidden =
		theatreStatus === "blackout" || theatreStatus === "counting";

	const startTheatre = useCallback((skipAnimation = false) => {
		if (skipAnimation) {
			setTheatreStatus("live");
		} else {
			setTheatreStatus("blackout");
		}
	}, []);

	const handleBeamStart = useCallback(() => {
		setTheatreStatus("beam");
	}, []);

	const handleTheatreComplete = useCallback(() => {
		setTheatreStatus("live");
	}, []);

	const resetTheatre = useCallback(() => {
		setTheatreStatus("idle");
	}, []);

	return {
		theatreStatus,
		isUIHidden,
		startTheatre,
		handleBeamStart,
		handleTheatreComplete,
		resetTheatre,
	};
}
