import { HeartIcon, NoteIcon, SparkleIcon } from "./KawaiiIcons";

interface MikuBannerProps {
	active: boolean;
}

export const MikuBanner = ({ active }: MikuBannerProps) => {
	return (
		<div
			className={`relative w-full h-64 md:h-80 rounded-3xl overflow-hidden mb-6 transition-all duration-500 border-2 ${
				active
					? "shadow-[0_0_40px_rgba(57,197,187,0.4)] scale-[1.01] border-miku-teal/50"
					: "shadow-lg border-miku-pink/20"
			}`}
		>
			{/* Background gradient */}
			<div className="absolute inset-0 bg-gradient-to-br from-miku-teal/5 via-white/50 to-miku-pink/5" />

			{/* The GIF */}
			<img
				src="/miku1.gif"
				alt="Miku Beam"
				loading="lazy"
				className={`w-full h-full object-cover transition-all duration-500 ${
					active ? "opacity-100 scale-105" : "opacity-70 grayscale-[20%]"
				}`}
			/>

			{/* Cute sparkle decorations - only visible when active */}
			{active && (
				<div className="absolute inset-0 pointer-events-none">
					<SparkleIcon
						className="absolute top-4 left-[10%] text-white/80 sparkle drop-shadow-lg"
						size={20}
					/>
					<NoteIcon
						className="absolute top-8 right-[15%] text-white/80 sparkle drop-shadow-lg"
						size={16}
						style={{ animationDelay: "0.3s" }}
					/>
					<HeartIcon
						className="absolute bottom-16 left-[20%] text-white/80 sparkle drop-shadow-lg"
						size={14}
						style={{ animationDelay: "0.7s" }}
					/>
					<SparkleIcon
						className="absolute top-1/3 right-[10%] text-white/80 sparkle drop-shadow-lg"
						size={18}
						style={{ animationDelay: "1s" }}
					/>
				</div>
			)}

			{/* Active overlay with beam text */}
			{active && (
				<>
					{/* Soft glow overlay */}
					<div className="absolute inset-0 bg-gradient-to-t from-miku-teal/20 via-transparent to-miku-pink/10 animate-pulse mix-blend-overlay" />

					{/* Bottom text - stylized beam text */}
					<div className="absolute bottom-0 left-0 right-0">
						<div className="bg-gradient-to-t from-black/60 via-black/30 to-transparent pt-12 pb-4 px-4">
							<div className="flex items-center justify-center gap-3">
								<div className="flex items-center">
									<span className="text-3xl md:text-4xl font-black text-white drop-shadow-[0_2px_10px_rgba(57,197,187,0.8)] tracking-tight">
										MIKU
									</span>
									<HeartIcon
										className="text-miku-pink mx-2 drop-shadow-lg animate-heart-beat"
										size={28}
									/>
									<span className="text-3xl md:text-4xl font-black text-white drop-shadow-[0_2px_10px_rgba(255,183,197,0.8)] tracking-tight">
										MIKU
									</span>
									<HeartIcon
										className="text-miku-teal mx-2 drop-shadow-lg animate-heart-beat"
										size={28}
										style={{ animationDelay: "0.3s" }}
									/>
									<span className="text-3xl md:text-4xl font-black text-white drop-shadow-[0_2px_10px_rgba(224,80,157,0.8)] tracking-tight">
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
