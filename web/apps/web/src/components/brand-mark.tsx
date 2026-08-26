interface BrandMarkProps {
	className?: string;
}

/**
 * AICP 的品牌标识把字母 A 与三个协作 Agent 节点合并为一个符号：顶部节点代表任务
 * 入口，底部两个节点代表可替换的执行者，中间连线表示由协议协调，而不是孤立聊天。
 * SVG 使用固定 viewBox 和透明背景，确保它能直接融入导航栏与浏览器标签，而不会
 * 在不同背景上出现额外的黑色方块。
 */
export default function BrandMark({ className }: BrandMarkProps) {
	return (
		<svg
			viewBox="0 0 48 48"
			className={className}
			fill="none"
			aria-hidden="true"
			data-testid="aicp-brand-mark"
		>
			<defs>
				<linearGradient
					id="aicp-mark-surface"
					x1="5"
					y1="4"
					x2="43"
					y2="44"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#8B5CF6" />
					<stop offset="0.52" stopColor="#6D28D9" />
					<stop offset="1" stopColor="#06B6D4" />
				</linearGradient>
				<linearGradient
					id="aicp-mark-line"
					x1="14"
					y1="10"
					x2="36"
					y2="38"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#FFFFFF" />
					<stop offset="1" stopColor="#A5F3FC" />
				</linearGradient>
				<filter
					id="aicp-mark-glow"
					x="-40%"
					y="-40%"
					width="180%"
					height="180%"
				>
					<feGaussianBlur stdDeviation="1.4" result="blur" />
					<feMerge>
						<feMergeNode in="blur" />
						<feMergeNode in="SourceGraphic" />
					</feMerge>
				</filter>
			</defs>
			<path
				d="M24 4.5 42 14.8v18.4L24 43.5 6 33.2V14.8L24 4.5Z"
				fill="url(#aicp-mark-surface)"
				fillOpacity="0.28"
				stroke="url(#aicp-mark-surface)"
				strokeWidth="1.2"
			/>
			<path
				d="M14.5 35 24 11.5 33.5 35M18.2 27.2h11.6"
				stroke="url(#aicp-mark-line)"
				strokeWidth="3.2"
				strokeLinecap="round"
				strokeLinejoin="round"
				filter="url(#aicp-mark-glow)"
			/>
			<path
				d="M24 12v15.2M14.5 35l9.5-7.8 9.5 7.8"
				stroke="#67E8F9"
				strokeOpacity="0.58"
				strokeWidth="1.1"
				strokeDasharray="2.2 2.2"
			/>
			<circle
				cx="24"
				cy="10.5"
				r="3.1"
				fill="#C4B5FD"
				stroke="white"
				strokeWidth="1.2"
			/>
			<circle
				cx="13.5"
				cy="36"
				r="3.1"
				fill="#8B5CF6"
				stroke="white"
				strokeWidth="1.2"
			/>
			<circle
				cx="34.5"
				cy="36"
				r="3.1"
				fill="#22D3EE"
				stroke="white"
				strokeWidth="1.2"
			/>
			<circle
				cx="24"
				cy="27.2"
				r="2.2"
				fill="#F0ABFC"
				stroke="white"
				strokeWidth="1"
			/>
		</svg>
	);
}
