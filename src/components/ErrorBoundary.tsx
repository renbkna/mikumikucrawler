import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
	children: ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
		console.error("ErrorBoundary caught an error:", error, errorInfo);
	}

	handleRetry = (): void => {
		this.setState({ hasError: false, error: null });
	};

	render(): ReactNode {
		if (this.state.hasError) {
			return (
				<div className="fixed inset-0 flex items-center justify-center bg-miku-bg">
					<div className="glass-panel p-8 max-w-md text-center space-y-6">
						<div className="text-6xl animate-bounce-slow">😿</div>
						<h1 className="text-2xl font-black text-miku-teal">
							Oops! Something went wrong
						</h1>
						<p className="text-slate-600">
							Miku encountered an unexpected error. Don't worry, it happens to
							the best of us!
						</p>
						{this.state.error && (
							<details className="text-left bg-slate-100 rounded-xl p-4 text-xs">
								<summary className="cursor-pointer font-bold text-slate-500">
									Error Details
								</summary>
								<pre className="mt-2 text-rose-500 whitespace-pre-wrap break-all">
									{this.state.error.message}
								</pre>
							</details>
						)}
						<div className="flex gap-4 justify-center">
							<button
								type="button"
								onClick={this.handleRetry}
								className="px-6 py-3 rounded-2xl bg-gradient-to-r from-miku-teal to-teal-400 text-white font-bold shadow-lg hover:scale-105 transition-transform"
							>
								Try Again
							</button>
							<button
								type="button"
								onClick={() => globalThis.location.reload()}
								className="px-6 py-3 rounded-2xl bg-white border-2 border-miku-pink text-miku-pink font-bold hover:bg-miku-pink hover:text-white transition-colors"
							>
								Reload Page
							</button>
						</div>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
