"use client";

import { ArrowLeft } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";

import { useLocale } from "@/components/i18n/locale-provider";
import type { MessageId } from "@/lib/i18n/messages";

type PageBackLinkProps = Readonly<{
	href: Route;
	label: MessageId;
}>;

/**
 * 返回是次级导航：常态只呈现箭头与文字，避免边框、底色和发光抢占标题的视觉层级。
 * 保留 44px 点击高度、手型和键盘焦点环，让外观轻量化不会缩小实际操作范围；
 * 与正文的间距由页面布局控制，避免组件自带外边距破坏错误态中的并排操作。
 */
export default function PageBackLink({ href, label }: PageBackLinkProps) {
	const { t } = useLocale();
	return (
		<Link
			href={href}
			data-slot="page-back-link"
			className="group inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-md text-muted-foreground text-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background"
		>
			<ArrowLeft
				className="size-3.5 shrink-0 motion-safe:transition-transform motion-safe:duration-200 motion-safe:group-hover:-translate-x-0.5"
				aria-hidden
			/>
			{t(label)}
		</Link>
	);
}
