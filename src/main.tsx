import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
	throw new Error("Failed to find the root element");
}

function ApplicationRoot() {
	useEffect(() => {
		document.getElementById("loading-screen")?.remove();
	}, []);

	return (
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	);
}

createRoot(rootElement).render(
	<StrictMode>
		<ApplicationRoot />
	</StrictMode>,
);
