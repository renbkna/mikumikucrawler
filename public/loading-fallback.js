setTimeout(() => {
	if (document.documentElement.dataset.applicationReady === "true") return;
	const loadingScreen = document.getElementById("loading-screen");
	if (!loadingScreen) return;

	const title = document.getElementById("loading-title");
	const status = document.getElementById("loading-status");
	const retry = document.getElementById("loading-retry");
	if (title) title.textContent = "Application failed to start";
	if (status) status.textContent = "The application bundle did not load.";
	if (retry) {
		retry.hidden = false;
		retry.addEventListener("click", () => window.location.reload(), { once: true });
	}
}, 8000);
