import DaoGovernance from "@/components/platform/dao-governance";

/**
 * 页面文件保持为服务端入口，把钱包交互与状态管理集中封装在客户端组件中；这样路由本身
 * 不需要声明 `use client`，也不会把后续可服务端渲染的页面元数据一并推入客户端包。
 */
export default function DaoPage() {
	return <DaoGovernance />;
}
