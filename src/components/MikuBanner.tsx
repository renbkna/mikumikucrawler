import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface MikuBannerProps {
	active: boolean;
}

export const MikuBanner = ({ active }: MikuBannerProps) => {
	return (
		<div
			className={`relative w-full h-56 md:h-72 rounded-[18px] overflow-hidden mb-3 transition-all duration-500 border ${
				active
					? "shadow-[0_10px_36px_rgba(105,201,229,0.16)] scale-[1.01] border-miku-teal/60"
					: "shadow-[0_8px_28px_rgba(105,117,170,0.06)] border-miku-accent/20"
			}`}
		>
			<div className="absolute inset-0 bg-white" />

			<img
				src="/miku1.gif"
				alt="Miku Beam"
				className={`w-full h-full object-cover transition-all duration-500 ${
					active ? "opacity-100 scale-[1.02]" : "opacity-90"
				}`}
			/>

			{active && (
				<div className="absolute inset-0 pointer-events-none">
					<SparkleIcon
						className="absolute top-4 right-[8%] text-white/70 sparkle drop-shadow-sm"
						size={16}
					/>
					<NoteIcon className="hidden" size={16} style={{ animationDelay: "0.3s" }} />
					<HeartIcon
						className="absolute bottom-5 left-1/2 text-miku-pink/75 drop-shadow-sm"
						size={14}
						style={{ animationDelay: "0.7s" }}
					/>
					<SparkleIcon className="hidden" size={18} style={{ animationDelay: "1s" }} />
				</div>
			)}

			{active && (
				<>
					<div className="absolute inset-0 bg-gradient-to-t from-miku-accent/10 via-transparent to-white/5 animate-pulse mix-blend-screen" />

					<div className="absolute bottom-0 left-0 right-0">
						<div className="bg-gradient-to-t from-[#6d61d8]/45 via-[#6d61d8]/10 to-transparent pt-10 pb-3 px-4">
							<div className="flex items-center justify-center gap-3">
								<div className="flex items-center">
									<span className="text-2xl md:text-3xl font-bold text-white drop-shadow-sm tracking-[0.08em]">
										MIKU
									</span>
									<HeartIcon
										className="text-miku-pink mx-2 drop-shadow-sm animate-heart-beat"
										size={18}
									/>
									<span className="text-2xl md:text-3xl font-bold text-white drop-shadow-sm tracking-[0.08em]">
										MIKU
									</span>
									<HeartIcon className="hidden" size={18} style={{ animationDelay: "0.3s" }} />
									<span className="text-2xl md:text-3xl font-bold text-white drop-shadow-sm tracking-[0.08em]">
										BEAM!
									</span>
								</div>
							</div>
						</div>
					</div>
				</>
			)}
		</div>
	);
};
