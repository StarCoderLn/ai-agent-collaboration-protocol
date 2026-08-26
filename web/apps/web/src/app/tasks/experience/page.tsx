import { redirect } from "next/navigation";

/**
 * 编排必须绑定一项真实任务。旧入口只保留兼容跳转，避免书签或历史链接继续把用户
 * 带进一个脱离任务、预算和候选快照的孤立体验页。
 */
export default function LegacyTaskExperiencePage() {
	redirect("/tasks/new");
}
