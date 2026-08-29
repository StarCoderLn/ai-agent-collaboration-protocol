"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { useLocale } from "@/components/i18n/locale-provider";

/**
 * 所有工作台二级页都通过同一个入口返回，统一路由、命名和点击范围，避免各模块再次
 * 出现外观相似但返回目标不同的导航。
 */
export default function WorkspaceBackLink() {
	const { t } = useLocale();

	return (
		<Link
			href="/workspace"
			className="group inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-primary/15 bg-card/55 px-4 font-medium text-muted-foreground text-sm backdrop-blur-md transition-[color,border-color,background-color] hover:border-primary/35 hover:bg-primary-container hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
		>
			<ArrowLeft
				className="size-4 transition-transform group-hover:-translate-x-0.5"
				aria-hidden
			/>
			{t("返回工作台")}
		</Link>
	);
}
