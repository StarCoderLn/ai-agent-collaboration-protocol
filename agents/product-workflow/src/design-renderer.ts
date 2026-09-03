import type { DesignDraft } from "./domain.js";

export type RenderedDesignScreen = Readonly<{
  id: "desktop" | "mobile";
  label: string;
  viewport: Readonly<{ width: number; height: number }>;
  canvas: Readonly<{ width: number; height: number }>;
  mimeType: "image/svg+xml";
  content: string;
}>;

type ScreenMode = RenderedDesignScreen["id"];

/**
 * 平台渲染器只消费已经通过 DesignDraftSchema 的可信结构，不执行 Agent 返回的 HTML、
 * CSS 或脚本。两张设计稿来自同一份 DesignSpec，因此用户看到的图片与 Coding Agent
 * 接收的布局、文案和视觉 token 不会形成两套互相漂移的事实源。
 */
export function renderDesignScreens(draft: DesignDraft): readonly RenderedDesignScreen[] {
  return [renderScreen(draft, "desktop"), renderScreen(draft, "mobile")];
}

function renderScreen(draft: DesignDraft, mode: ScreenMode): RenderedDesignScreen {
  const mobile = mode === "mobile";
  const width = mobile ? 390 : 1_440;
  const viewportHeight = mobile ? 844 : 900;
  const sections = draft.preview.sections.slice(0, 4);
	// 没有指标时不能预留一整行空白；移动端每行两个，桌面端存在指标时始终一行。
	const metricCount = Math.min(draft.preview.metrics.length, 4);
  const metricRows = metricCount === 0 ? 0 : mobile ? Math.ceil(metricCount / 2) : 1;
  const sectionRows = mobile ? sections.length : Math.ceil(sections.length / 2);
  const canvasHeight = mobile
    ? 390 + metricRows * 96 + sectionRows * 218 + 52
    : 570 + sectionRows * 250 + 70;
  const primary = draft.tokens.primaryColor;
  const secondary = draft.tokens.secondaryColor;
  const background = draft.tokens.backgroundColor;
  const text = draft.tokens.textColor;
	const buttonText = contrastText(primary);
	const fontStack = trustedSvgFontStack(draft.tokens.fontFamily);
  const margin = mobile ? 16 : 64;
  const contentWidth = width - margin * 2;
  const navigation = renderNavigation(draft, { mobile, x: margin, y: mobile ? 16 : 34, width: contentWidth });
  const heroY = mobile ? 96 : 132;
  const heroHeight = mobile ? 238 : 248;
  const hero = renderHero(draft, {
    mobile, x: margin, y: heroY, width: contentWidth, height: heroHeight, primary, secondary, text, background,
  });
  const metricsY = heroY + heroHeight + (mobile ? 18 : 22);
  const metrics = renderMetrics(draft, {
    mobile, x: margin, y: metricsY, width: contentWidth, primary, text,
  });
  const sectionsY = metricsY + metricRows * 96 + (mobile ? 18 : 28);
  const sectionMarkup = sections.map((section, index) => {
    const column = mobile ? 0 : index % 2;
    const row = mobile ? index : Math.floor(index / 2);
    const gap = mobile ? 0 : 20;
    const sectionWidth = mobile ? contentWidth : (contentWidth - gap) / 2;
    return renderSection(section, {
      mobile,
      x: margin + column * (sectionWidth + gap),
      y: sectionsY + row * (mobile ? 218 : 250),
      width: sectionWidth,
      height: mobile ? 202 : 232,
      primary,
      text,
    });
  }).join("");

  // SVG 只包含平台固定图元和转义后的业务文字；即使用户输入包含类似标签的文本，
  // 也只会作为可见字符出现，不能突破图片边界执行脚本或加载远程资源。
  const content = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${canvasHeight}" viewBox="0 0 ${width} ${canvasHeight}" role="img" aria-label="${escapeXml(draft.title)}">
<rect width="${width}" height="${canvasHeight}" fill="${background}"/>
<circle cx="${mobile ? width - 12 : width - 120}" cy="${mobile ? 90 : 70}" r="${mobile ? 94 : 260}" fill="${primary}" opacity="0.10"/>
<circle cx="${mobile ? 26 : 120}" cy="${canvasHeight - 80}" r="${mobile ? 82 : 220}" fill="${secondary}" opacity="0.08"/>
<style>
.title{font:800 ${mobile ? 29 : 48}px ${fontStack};letter-spacing:-.035em;fill:${text}}
.subtitle{font:500 ${mobile ? 13 : 16}px ${fontStack};fill:${text};opacity:.70}
.heading{font:750 ${mobile ? 15 : 18}px ${fontStack};fill:${text}}
.body{font:500 ${mobile ? 11 : 13}px ${fontStack};fill:${text};opacity:.68}
.label{font:700 ${mobile ? 10 : 11}px ${fontStack};letter-spacing:.08em;fill:${primary}}
.value{font:800 ${mobile ? 18 : 23}px ${fontStack};fill:${text}}
.button{font:750 ${mobile ? 11 : 13}px ${fontStack};fill:${buttonText}}
</style>
${navigation}${hero}${metrics}${sectionMarkup}
<text x="${margin}" y="${canvasHeight - 24}" class="body">${escapeXml(draft.title)} · ${mode === "desktop" ? "Desktop 1440" : "Mobile 390"}</text>
</svg>`;
  return {
    id: mode,
    label: mode === "desktop" ? "桌面端设计稿" : "移动端设计稿",
    viewport: { width, height: viewportHeight },
    canvas: { width, height: canvasHeight },
    mimeType: "image/svg+xml",
    content,
  };
}

function renderNavigation(
  draft: DesignDraft,
  options: Readonly<{ mobile: boolean; x: number; y: number; width: number }>,
): string {
  const navigation = draft.preview.navigation;
  if (navigation === null) return "";
  const brand = truncate(navigation.brand, options.mobile ? 14 : 24);
  const items = navigation.items.slice(0, options.mobile ? 2 : 5);
  const itemMarkup = items.map((item, index) => {
    const x = options.mobile ? options.x + 150 + index * 74 : options.x + 280 + index * 112;
    return `<text x="${x}" y="${options.y + 30}" class="body" opacity="${item.active ? 1 : .72}">${escapeXml(truncate(item.label, 8))}</text>`;
  }).join("");
  const action = navigation.action === null || options.mobile
    ? ""
    : `<rect x="${options.x + options.width - 132}" y="${options.y + 4}" width="132" height="42" rx="14" fill="${draft.tokens.primaryColor}"/><text x="${options.x + options.width - 66}" y="${options.y + 30}" text-anchor="middle" class="button">${escapeXml(truncate(navigation.action, 12))}</text>`;
  return `<g data-region="navigation"><text x="${options.x}" y="${options.y + 31}" class="heading">${escapeXml(brand)}</text>${itemMarkup}${action}</g>`;
}

function renderHero(
  draft: DesignDraft,
  options: Readonly<{
    mobile: boolean; x: number; y: number; width: number; height: number; primary: string; secondary: string;
		text: string; background: string;
  }>,
): string {
  const hero = draft.preview.hero;
  const textWidth = options.mobile ? options.width - 32 : options.width * .58;
  const titleLines = wrapText(hero.title, options.mobile ? 17 : 24, 2);
  const descriptionLines = wrapText(hero.description, options.mobile ? 30 : 46, options.mobile ? 3 : 2);
  const title = renderTextLines(titleLines, options.x + (options.mobile ? 18 : 34), options.y + (options.mobile ? 72 : 88), "title", options.mobile ? 35 : 56);
  const descriptionY = options.y + (options.mobile ? 146 : 174);
  const description = renderTextLines(descriptionLines, options.x + (options.mobile ? 18 : 34), descriptionY, "subtitle", options.mobile ? 20 : 24);
  const buttonWidth = options.mobile ? 116 : 142;
  const buttonY = options.y + options.height - (options.mobile ? 50 : 58);
  const secondary = hero.secondaryAction === null
    ? ""
    : `<rect x="${options.x + (options.mobile ? 18 : 34) + buttonWidth + 12}" y="${buttonY}" width="${buttonWidth}" height="40" rx="13" fill="${options.background}" stroke="${options.primary}" opacity=".92"/><text x="${options.x + (options.mobile ? 18 : 34) + buttonWidth * 1.5 + 12}" y="${buttonY + 25}" text-anchor="middle" class="body">${escapeXml(truncate(hero.secondaryAction, 10))}</text>`;
  const visual = options.mobile ? "" : `<g transform="translate(${options.x + textWidth + 34} ${options.y + 34})">
    <rect width="${options.width - textWidth - 68}" height="180" rx="24" fill="${options.text}" opacity=".07"/>
    <rect x="24" y="25" width="118" height="12" rx="6" fill="${options.primary}" opacity=".26"/>
    <rect x="24" y="54" width="${options.width - textWidth - 118}" height="16" rx="8" fill="${options.primary}" opacity=".78"/>
    <rect x="24" y="88" width="${(options.width - textWidth - 110) * .62}" height="58" rx="17" fill="${options.secondary}" opacity=".14"/>
    <rect x="${(options.width - textWidth) * .63}" y="88" width="${(options.width - textWidth - 110) * .30}" height="58" rx="17" fill="${options.primary}" opacity=".16"/>
  </g>`;
  return `<g data-region="hero"><rect x="${options.x}" y="${options.y}" width="${options.width}" height="${options.height}" rx="${options.mobile ? 24 : 30}" fill="${options.text}" fill-opacity=".055" stroke="${options.primary}" stroke-opacity=".24"/>
  <text x="${options.x + (options.mobile ? 18 : 34)}" y="${options.y + 34}" class="label">${escapeXml(truncate(hero.eyebrow, 20))}</text>
  ${title}${description}
  <rect x="${options.x + (options.mobile ? 18 : 34)}" y="${buttonY}" width="${buttonWidth}" height="40" rx="13" fill="${options.primary}"/><text x="${options.x + (options.mobile ? 18 : 34) + buttonWidth / 2}" y="${buttonY + 25}" text-anchor="middle" class="button">${escapeXml(truncate(hero.primaryAction, 10))}</text>${secondary}${visual}</g>`;
}

function renderMetrics(
  draft: DesignDraft,
  options: Readonly<{ mobile: boolean; x: number; y: number; width: number; primary: string; text: string }>,
): string {
  const metrics = draft.preview.metrics.slice(0, 4);
  if (metrics.length === 0) return "";
  const columns = options.mobile ? 2 : metrics.length;
  const gap = options.mobile ? 10 : 14;
  const cardWidth = (options.width - gap * (columns - 1)) / columns;
  return metrics.map((metric, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = options.x + column * (cardWidth + gap);
    const y = options.y + row * 96;
    return `<g data-region="metric-${index + 1}"><rect x="${x}" y="${y}" width="${cardWidth}" height="82" rx="17" fill="${options.text}" fill-opacity=".05" stroke="${options.primary}" stroke-opacity=".18"/>
      <text x="${x + 15}" y="${y + 23}" class="body">${escapeXml(truncate(metric.label, options.mobile ? 10 : 18))}</text>
      <text x="${x + 15}" y="${y + 52}" class="value">${escapeXml(truncate(metric.value, options.mobile ? 12 : 18))}</text>
      <text x="${x + 15}" y="${y + 70}" class="body">${escapeXml(truncate(metric.detail, options.mobile ? 14 : 24))}</text>
    </g>`;
  }).join("");
}

function renderSection(
  section: DesignDraft["preview"]["sections"][number],
  options: Readonly<{ mobile: boolean; x: number; y: number; width: number; height: number; primary: string; text: string }>,
): string {
  const items = section.items.slice(0, options.mobile ? 3 : 4);
  const contentTop = options.y + 74;
  const itemHeight = options.mobile ? 34 : 36;
  const itemMarkup = items.map((item, index) => {
    const y = contentTop + index * itemHeight;
    const trailing = item.value ?? item.status ?? (item.progress === null ? null : `${item.progress}%`) ?? item.action;
    return `<g><rect x="${options.x + 16}" y="${y - 19}" width="${options.width - 32}" height="${itemHeight - 4}" rx="10" fill="${options.primary}" opacity="${index % 2 === 0 ? .055 : .025}"/>
      <text x="${options.x + 28}" y="${y}" class="body">${escapeXml(truncate(item.title, options.mobile ? 18 : 24))}</text>
      ${trailing === null ? "" : `<text x="${options.x + options.width - 28}" y="${y}" text-anchor="end" class="body">${escapeXml(truncate(trailing, options.mobile ? 10 : 16))}</text>`}
    </g>`;
  }).join("");
  return `<g data-region="${escapeXml(section.id)}"><rect x="${options.x}" y="${options.y}" width="${options.width}" height="${options.height}" rx="22" fill="${options.text}" fill-opacity=".05" stroke="${options.primary}" stroke-opacity=".18"/>
    <text x="${options.x + 20}" y="${options.y + 29}" class="heading">${escapeXml(truncate(section.title, options.mobile ? 18 : 28))}</text>
    <rect x="${options.x + options.width - 82}" y="${options.y + 14}" width="62" height="24" rx="12" fill="${options.primary}" opacity=".10"/><text x="${options.x + options.width - 51}" y="${options.y + 30}" text-anchor="middle" class="label">${escapeXml(section.kind.toUpperCase())}</text>
    ${section.description === null ? "" : `<text x="${options.x + 20}" y="${options.y + 52}" class="body">${escapeXml(truncate(section.description, options.mobile ? 30 : 50))}</text>`}
    ${itemMarkup}
  </g>`;
}

function renderTextLines(lines: readonly string[], x: number, y: number, className: string, lineHeight: number): string {
  return `<text x="${x}" y="${y}" class="${className}">${lines.map((line, index) =>
    `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function wrapText(value: string, maxCharacters: number, maxLines: number): string[] {
  const normalized = value.trim().replace(/\s+/g, " ");
  const lines: string[] = [];
  for (let offset = 0; offset < normalized.length && lines.length < maxLines; offset += maxCharacters) {
    const slice = normalized.slice(offset, offset + maxCharacters);
    const hasMore = offset + maxCharacters < normalized.length;
    lines.push(hasMore && lines.length === maxLines - 1 ? `${slice.slice(0, -1)}…` : slice);
  }
  return lines.length === 0 ? [""] : lines;
}

function truncate(value: string, maxCharacters: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maxCharacters ? normalized : `${normalized.slice(0, Math.max(1, maxCharacters - 1))}…`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** 主色可能是很亮的黄色或青色，按钮文字必须根据相对亮度选择黑/白而不是固定白色。 */
function contrastText(hex: string): "#111827" | "#ffffff" {
	const red = Number.parseInt(hex.slice(1, 3), 16);
	const green = Number.parseInt(hex.slice(3, 5), 16);
	const blue = Number.parseInt(hex.slice(5, 7), 16);
	return red * 299 + green * 587 + blue * 114 > 160_000 ? "#111827" : "#ffffff";
}

/** SVG 只使用本机字体栈；自由文本字体名不能直接进入 style 标签或触发远程字体请求。 */
function trustedSvgFontStack(fontFamily: string): string {
	const normalized = fontFamily.toLowerCase();
	if (normalized.includes("mono")) return "ui-monospace,monospace";
	if (normalized.includes("serif") && !normalized.includes("sans")) return "ui-serif,serif";
	return "ui-sans-serif,system-ui,sans-serif";
}
