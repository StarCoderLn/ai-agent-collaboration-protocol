import "@testing-library/jest-dom/vitest";

// jsdom 没有布局引擎，也未实现 ResizeObserver。React Flow 只依赖它触发节点尺寸同步；
// 测试关注节点业务交互而不是像素测量，因此使用无副作用实现保持浏览器契约即可。
if (globalThis.ResizeObserver === undefined) {
	globalThis.ResizeObserver = class ResizeObserver {
		disconnect(): void {}
		observe(): void {}
		unobserve(): void {}
	};
}
