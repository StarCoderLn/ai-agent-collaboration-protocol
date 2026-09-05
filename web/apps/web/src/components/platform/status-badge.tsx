"use client";

import {
	AlertTriangle,
	CheckCircle2,
	CircleDashed,
	Clock3,
	Cpu,
	ShieldCheck,
} from "lucide-react";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	TASK_STATUS_PRESENTATION,
	type TaskStatus,
} from "@/lib/platform/contracts";

const TONES = {
	neutral: "bg-muted text-muted-foreground",
	primary: "bg-primary-container text-primary",
	ai: "bg-secondary-container text-secondary-container-foreground",
	escrow: "bg-tertiary-container text-tertiary-container-foreground",
	success: "bg-success/10 text-success",
	warning: "bg-warning/10 text-warning",
	danger: "bg-destructive-container text-destructive",
} as const;

const ICONS = {
	neutral: CircleDashed,
	primary: Cpu,
	ai: Cpu,
	escrow: ShieldCheck,
	success: CheckCircle2,
	warning: Clock3,
	danger: AlertTriangle,
} as const;

export function StatusBadge({ status }: { status: TaskStatus }) {
	const { t } = useLocale();
	const presentation = TASK_STATUS_PRESENTATION[status];
	const Icon = ICONS[presentation.tone];
	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-xs ${TONES[presentation.tone]}`}
		>
			<Icon className="size-3.5" strokeWidth={1.5} aria-hidden />
			{t(presentation.label)}
		</span>
	);
}

export function SandboxBadge() {
	const { t } = useLocale();
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full border border-tertiary/20 bg-tertiary-container px-2.5 py-1 font-medium text-tertiary-container-foreground text-xs">
			<ShieldCheck className="size-3.5" strokeWidth={1.5} aria-hidden />
			{t("平台保障")}
		</span>
	);
}
