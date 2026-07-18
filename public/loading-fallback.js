setTimeout(() => {
	const loadingScreen = document.getElementById("loading-screen");
	if (!loadingScreen) return;

	loadingScreen.style.opacity = "0";
	loadingScreen.style.transition = "opacity 500ms ease-in-out";
	setTimeout(() => {
		loadingScreen.style.display = "none";
	}, 500);
}, 3000);
