import { cn } from "@web/ui/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			className={cn("rounded-lg", className)}
			{...props}
		/>
	);
}

export { Skeleton };
