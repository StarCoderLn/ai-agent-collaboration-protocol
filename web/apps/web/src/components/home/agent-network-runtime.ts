import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

export interface AgentNetworkRuntime {
	dispose: () => void;
}

/**
 * 整个首屏共用一个透明画布。正交相机将 DOM 像素映射到场景单位，模型以右侧留白
 * 的中心定位，而不是在右侧创建另一个视口。因此跨过两列交界的轨道仍能完整显示。
 * 主体采用开放式办公室、四个机器人及工位，共享看板与制品流转灯带表达协作过程。
 */
export function createAgentNetworkRuntime(
	canvas: HTMLCanvasElement,
): AgentNetworkRuntime {
	const engine = new Engine(canvas, true, { alpha: true, stencil: false });
	const scene = new Scene(engine);
	try {
		scene.clearColor = new Color4(0, 0, 0, 0);
		const camera = new FreeCamera(
			"network-camera",
			new Vector3(0, 0, -30),
			scene,
		);
		camera.setTarget(Vector3.Zero());
		camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
		const assembly = new TransformNode("collaboration-observatory", scene);

		const office = new TransformNode("agent-team-office", scene);
		office.parent = assembly;
		// 固定正面机位：只保留轻微俯视，整体不随指针或时间左右偏转。
		office.rotation.set((-25 * Math.PI) / 180, 0, 0);
		const ambient = new HemisphericLight(
			"studio-fill",
			new Vector3(0, 1, -1),
			scene,
		);
		ambient.intensity = 0.55;
		const key = new PointLight("softbox", new Vector3(-4, 7, -6), scene);
		key.intensity = 0.65;
		const rim = new PointLight("violet-rim", new Vector3(4, 4, 2), scene);
		rim.diffuse = Color3.FromHexString("#A78BFA");
		rim.intensity = 1.2;
		const glow = new GlowLayer("office-signals", scene, { blurKernelSize: 24 });
		glow.intensity = 0.55;
		const sun = new DirectionalLight(
			"soft-studio-shadow",
			new Vector3(0.4, -1, 0.35),
			scene,
		);
		sun.position.set(-5, 8, -5);
		sun.intensity = 0.65;
		const shadows = new ShadowGenerator(1024, sun);
		shadows.useBlurExponentialShadowMap = true;
		shadows.blurKernel = 16;
		shadows.darkness = 0.3;

		/** 所有家具使用同一材质目录；白色机器人与深色桌面形成层次，发光只用于状态灯。 */
		const material = (name: string, hex: string, emissive = false) => {
			const result = new StandardMaterial(name, scene);
			result.diffuseColor = Color3.FromHexString(hex);
			result.emissiveColor = result.diffuseColor.scale(emissive ? 0.65 : 0.015);
			result.specularColor = Color3.FromHexString("#555571");
			result.specularPower = 48;
			return result;
		};
		const floor = material("lavender-floor", "#3E3A60");
		const desk = material("pearl-desks", "#B4B1CE");
		const dark = material("graphite", "#19172C");
		const white = material("ceramic-agent-shell", "#E0DCF1");
		const glass = material("agent-visor", "#10182B");
		const violet = material("planning-agent", "#B398FA", true);
		const cyan = material("research-agent", "#62DADB", true);
		const amber = material("design-agent", "#F0B97D", true);
		const green = material("delivery-agent", "#8DDBB3", true);
		const leaf = material("plant-leaves", "#478B80");
		const accents = [violet, cyan, amber, green];
		/** 家具的位置均在办公室局部坐标中；整个房间缩放时不会让机器人与工位错位。 */
		const box = (
			name: string,
			x: number,
			y: number,
			z: number,
			w: number,
			h: number,
			d: number,
			surface: StandardMaterial,
			parent: TransformNode = office,
		) => {
			const mesh = CreateBox(name, { width: w, height: h, depth: d }, scene);
			mesh.position.set(x, y, z);
			mesh.material = surface;
			mesh.parent = parent;
			return mesh;
		};
		const sphere = (
			name: string,
			x: number,
			y: number,
			z: number,
			w: number,
			h: number,
			d: number,
			surface: StandardMaterial,
			parent: TransformNode = office,
		) => {
			const mesh = CreateSphere(name, { diameter: 1, segments: 24 }, scene);
			mesh.position.set(x, y, z);
			mesh.scaling.set(w, h, d);
			mesh.material = surface;
			mesh.parent = parent;
			return mesh;
		};
		const tube = (
			name: string,
			points: Vector3[],
			radius: number,
			surface: StandardMaterial,
			parent: TransformNode = office,
		) => {
			const mesh = CreateTube(
				name,
				{ path: points, radius, tessellation: 10 },
				scene,
			);
			mesh.parent = parent;
			mesh.material = surface;
			return mesh;
		};

		// 悬浮工作室使用椭圆平台与开放边界，低机位也能看到后排角色，不再被实体墙挡住。
		const base = CreateCylinder(
			"floating-plinth",
			{ height: 0.24, diameter: 7.8, tessellation: 96 },
			scene,
		);
		base.parent = office;
		base.position.y = -0.22;
		base.scaling.z = 0.76;
		base.material = dark;
		const platform = CreateCylinder(
			"office-floor",
			{ height: 0.1, diameter: 7.6, tessellation: 96 },
			scene,
		);
		platform.parent = office;
		platform.position.y = -0.05;
		platform.scaling.z = 0.76;
		platform.material = floor;
		platform.receiveShadows = true;
		const perimeter = Array.from(
			{ length: 129 },
			(_, i) =>
				new Vector3(
					Math.cos((i / 128) * Math.PI * 2) * 3.8,
					-0.16,
					Math.sin((i / 128) * Math.PI * 2) * 2.89,
				),
		);
		tube("platform-light-rim", perimeter, 0.016, violet);
		tube(
			"platform-inner-rim",
			perimeter.map((p) => new Vector3(p.x * 0.97, 0.02, p.z * 0.97)),
			0.006,
			cyan,
		);

		// 共享看板使用真实工作流语义的三列：输入、协作、交付，以连线与状态节点表达。
		box("shared-display-frame", 0, 1.45, 2.43, 3.3, 1.45, 0.12, dark);
		box("shared-display", 0, 1.45, 2.35, 3.1, 1.25, 0.02, glass);
		for (let i = 0; i < 3; i++) {
			const color = accents[i] ?? violet;
			box(`board-column-${i}`, -1 + i, 1.48, 2.31, 0.85, 0.8, 0.02, floor);
			box(`board-heading-${i}`, -1 + i, 1.84, 2.28, 0.72, 0.025, 0.02, color);
			for (let j = 0; j < 3; j++) {
				box(
					`board-task-${i}-${j}`,
					-1 + i,
					1.65 - j * 0.23,
					2.27,
					0.62,
					0.12,
					0.015,
					dark,
				);
				sphere(
					`board-dot-${i}-${j}`,
					-1.22 + i,
					1.65 - j * 0.23,
					2.24,
					0.04,
					0.04,
					0.025,
					color,
				);
			}
		}
		const heads: TransformNode[] = [];
		const workstationGroups: TransformNode[] = [];
		const signals: Array<{
			mesh: ReturnType<typeof CreateSphere>;
			start: Vector3;
			end: Vector3;
			phase: number;
		}> = [];
		const stations = [
			{ x: -2.1, z: -1.05 },
			{ x: 1.8, z: -1.05 },
			{ x: -2.1, z: 1.15 },
			{ x: 1.8, z: 1.15 },
		];
		stations.forEach(({ x, z }, i) => {
			const color = accents[i] ?? violet;
			const station = new TransformNode(`workstation-${i}`, scene);
			station.parent = office;
			station.position.set(x, 0, z);
			workstationGroups.push(station);
			box(`desk-top-${i}`, 0, 0.79, 0, 1.95, 0.1, 0.94, desk, station);
			box(`desk-trim-${i}`, 0, 0.74, -0.48, 1.9, 0.025, 0.02, color, station);
			for (const side of [-0.79, 0.79])
				box(
					`desk-leg-${i}-${side}`,
					side,
					0.37,
					0,
					0.075,
					0.74,
					0.64,
					dark,
					station,
				);
			box(
				`monitor-base-${i}`,
				0.16,
				0.86,
				0.17,
				0.44,
				0.045,
				0.26,
				dark,
				station,
			);
			box(
				`monitor-stem-${i}`,
				0.16,
				1.06,
				0.24,
				0.06,
				0.4,
				0.06,
				dark,
				station,
			);
			box(
				`monitor-shell-${i}`,
				0.16,
				1.35,
				0.23,
				1.02,
				0.64,
				0.075,
				dark,
				station,
			);
			box(
				`monitor-screen-${i}`,
				0.16,
				1.35,
				0.186,
				0.92,
				0.54,
				0.018,
				glass,
				station,
			);
			for (let line = 0; line < 5; line++) {
				box(
					`screen-code-${i}-${line}`,
					-0.04,
					1.52 - line * 0.075,
					0.172,
					0.25 + (line % 3) * 0.14,
					0.021,
					0.01,
					line === 0 ? color : desk,
					station,
				);
			}
			box(`keyboard-${i}`, 0.15, 0.86, -0.2, 0.64, 0.025, 0.22, dark, station);
			for (let row = 0; row < 3; row++)
				for (let col = 0; col < 8; col++)
					box(
						`key-${i}-${row}-${col}`,
						-0.1 + col * 0.067,
						0.875,
						-0.27 + row * 0.065,
						0.043,
						0.012,
						0.035,
						desk,
						station,
					);
			// 机器人由陶瓷头壳、深色面罩、发光双眼和关节组成，不用抽象几何块代替角色。
			sphere(
				`agent-body-${i}`,
				-0.48,
				0.84,
				-0.68,
				0.49,
				0.63,
				0.4,
				white,
				station,
			);
			const head = new TransformNode(`agent-head-${i}`, scene);
			head.parent = station;
			head.position.set(-0.48, 1.38, -0.65);
			heads.push(head);
			sphere(`agent-shell-${i}`, 0, 0, 0, 0.66, 0.51, 0.49, white, head);
			sphere(
				`agent-face-${i}`,
				0,
				-0.02,
				-0.218,
				0.51,
				0.29,
				0.12,
				glass,
				head,
			);
			for (const side of [-0.12, 0.12])
				sphere(
					`agent-eye-${i}-${side}`,
					side,
					0,
					-0.28,
					0.065,
					0.11,
					0.025,
					color,
					head,
				);
			tube(
				`antenna-${i}`,
				[new Vector3(0, 0.22, 0), new Vector3(0, 0.38, 0)],
				0.022,
				dark,
				head,
			);
			sphere(`antenna-light-${i}`, 0, 0.4, 0, 0.085, 0.085, 0.085, color, head);
			for (const side of [-1, 1]) {
				tube(
					`arm-${i}-${side}`,
					[
						new Vector3(-0.48 + side * 0.24, 1, -0.65),
						new Vector3(-0.48 + side * 0.34, 0.85, -0.45),
						new Vector3(-0.15 + side * 0.2, 0.88, -0.2),
					],
					0.06,
					white,
					station,
				);
				sphere(
					`hand-${i}-${side}`,
					-0.15 + side * 0.2,
					0.89,
					-0.2,
					0.14,
					0.09,
					0.14,
					color,
					station,
				);
				tube(
					`leg-${i}-${side}`,
					[
						new Vector3(-0.48 + side * 0.14, 0.62, -0.65),
						new Vector3(-0.48 + side * 0.14, 0.27, -0.75),
					],
					0.07,
					dark,
					station,
				);
			}
			box(`chair-seat-${i}`, -0.48, 0.52, -0.71, 0.6, 0.1, 0.55, dark, station);
			box(
				`chair-back-${i}`,
				-0.48,
				0.81,
				-0.96,
				0.57,
				0.5,
				0.07,
				floor,
				station,
			);
			const mug = CreateCylinder(
				`mug-${i}`,
				{ height: 0.17, diameter: 0.13, tessellation: 20 },
				scene,
			);
			mug.parent = station;
			mug.position.set(0.8, 0.92, -0.12);
			mug.material = color;
			// 工位之间的光路代表制品流转，动画沿固定路由移动，避免随机漂移影响空间阅读。
			const start = new Vector3(x, 0.12, z - 0.5);
			const end = new Vector3(x + 1.25, 0.12, z - 0.5);
			tube(`handoff-path-${i}`, [start, end], 0.015, color);
			const packet = sphere(
				`handoff-packet-${i}`,
				0,
				0,
				0,
				0.07,
				0.07,
				0.07,
				color,
			);
			signals.push({ mesh: packet, start, end, phase: i * 0.25 });
		});
		// 绿植和落地灯建立办公室尺度，减少整齐排列的设备带来的机房感。
		for (const x of [-3.05, 3.05]) {
			const pot = CreateCylinder(
				`planter-${x}`,
				{
					height: 0.4,
					diameterTop: 0.44,
					diameterBottom: 0.32,
					tessellation: 24,
				},
				scene,
			);
			pot.parent = office;
			pot.position.set(x, 0.22, 1.85);
			pot.material = desk;
			for (let i = 0; i < 5; i++) {
				const frond = sphere(
					`leaf-${x}-${i}`,
					x + Math.sin(i * 2) * 0.17,
					0.64 + i * 0.08,
					1.85 + Math.cos(i * 2) * 0.12,
					0.18,
					0.55,
					0.14,
					leaf,
				);
				frond.rotation.z = Math.sin(i) * 0.6;
			}
		}

		// 共享任务中心是工作室的视觉焦点：浮动屏、环形投影台与三维制品轨迹共用坐标系。
		const hub = new TransformNode("holographic-task-hub", scene);
		hub.parent = office;
		const projector = CreateCylinder(
			"projector",
			{ height: 0.15, diameter: 0.9, tessellation: 48 },
			scene,
		);
		projector.parent = hub;
		projector.position.y = 0.12;
		projector.material = dark;
		const haloMaterial = material("hologram-light", "#68DDEC", true);
		const halo = CreateCylinder(
			"hologram-halo",
			{ height: 0.02, diameter: 0.83, tessellation: 64 },
			scene,
		);
		halo.parent = hub;
		halo.position.y = 0.21;
		halo.material = haloMaterial;
		const hologram = new TransformNode("floating-shared-context", scene);
		hologram.parent = hub;
		hologram.position.set(0, 2.45, 0.25);
		const hologramGlass = material("holographic-glass", "#142B43", true);
		hologramGlass.alpha = 0.86;
		box("hologram-panel", 0, 0, 0, 1.32, 1.52, 0.055, hologramGlass, hologram);
		tube(
			"hologram-frame",
			[
				new Vector3(-0.66, -0.76, -0.035),
				new Vector3(-0.66, 0.76, -0.035),
				new Vector3(0.66, 0.76, -0.035),
				new Vector3(0.66, -0.76, -0.035),
				new Vector3(-0.66, -0.76, -0.035),
			],
			0.012,
			cyan,
			hologram,
		);
		const hubBars: Array<ReturnType<typeof CreateBox>> = [];
		for (let i = 0; i < 4; i++) {
			const accent = accents[i] ?? cyan;
			sphere(
				`hub-role-${i}`,
				-0.43,
				0.45 - i * 0.31,
				-0.06,
				0.1,
				0.1,
				0.035,
				accent,
				hologram,
			);
			const bar = box(
				`hub-progress-${i}`,
				0.1,
				0.45 - i * 0.31,
				-0.065,
				0.7,
				0.065,
				0.02,
				accent,
				hologram,
			);
			hubBars.push(bar);
		}
		// 有宽度的文件卡片与尾迹沿抛物线飞向共享屏，运动方向明确且从首帧就可见。
		const transfers = stations.map(({ x, z }, i) => {
			const carrier = new TransformNode(`artifact-transfer-${i}`, scene);
			carrier.parent = office;
			const color = accents[i] ?? cyan;
			box(`artifact-card-${i}`, 0, 0, 0, 0.34, 0.43, 0.045, dark, carrier);
			box(
				`artifact-accent-${i}`,
				0,
				0.13,
				-0.029,
				0.24,
				0.045,
				0.015,
				color,
				carrier,
			);
			for (let j = 0; j < 3; j++)
				box(
					`artifact-line-${i}-${j}`,
					-0.025,
					0.025 - j * 0.065,
					-0.029,
					0.19 - j * 0.035,
					0.019,
					0.015,
					white,
					carrier,
				);
			const start = new Vector3(x + 0.2, 1.65, z);
			const end = new Vector3(0, 2.5, 0.2);
			const route = Array.from({ length: 41 }, (_, j) => {
				const p = j / 40;
				const point = Vector3.Lerp(start, end, p);
				point.y += Math.sin(p * Math.PI) * 0.7;
				return point;
			});
			const routeMaterial = material(
				`transfer-route-${i}`,
				i % 2 ? "#62DADB" : "#B398FA",
				true,
			);
			routeMaterial.alpha = 0.24;
			tube(`transfer-arc-${i}`, route, 0.008, routeMaterial);
			const trail = Array.from({ length: 7 }, (_, j) =>
				sphere(
					`transfer-trail-${i}-${j}`,
					0,
					0,
					0,
					0.045 - j * 0.004,
					0.045 - j * 0.004,
					0.045 - j * 0.004,
					color,
				),
			);
			return { carrier, start, end, trail };
		});
		// 只让实体家具和角色投影；透明屏、灯带与运动轨迹不投影，避免虚假的黑色光束。
		for (const mesh of scene.meshes) {
			if (
				/^(agent-(shell|body)|desk-top|monitor-shell|planter)/.test(mesh.name)
			)
				shadows.addShadowCaster(mesh);
			if (mesh.name.startsWith("desk-top")) mesh.receiveShadows = true;
		}
		const hands = scene.meshes.filter((mesh) => mesh.name.startsWith("hand-"));
		const eyes = scene.meshes.filter((mesh) =>
			mesh.name.startsWith("agent-eye-"),
		);
		const codeLines = scene.meshes.filter((mesh) =>
			mesh.name.startsWith("screen-code-"),
		);
		const hero = canvas.closest("section");
		const anchor = hero?.querySelector(".hero-network-shell");
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const compact = window.matchMedia("(max-width: 767px)");
		let visible = true;
		let running = false;
		let elapsed = 0;
		let lastFrame = 0;

		/** 用实际经过时间推进时间轴；限帧只减少绘制次数，不再把动画速度一起减半。 */
		const draw = () => {
			const time = motion.matches ? 4 : elapsed;
			workstationGroups.forEach((station, i) => {
				const progress = motion.matches
					? 1
					: Math.max(0, Math.min((time - i * 0.14) / 1.1, 1));
				station.position.y = (1 - progress) ** 3 * 1.6;
			});
			heads.forEach((head, i) => {
				const working = (time + i * 1.3) % 5;
				head.rotation.y =
					working < 3
						? Math.sin(time * 1.5 + i) * 0.16
						: Math.sin(((working - 3) * Math.PI) / 2) * 0.65;
				head.rotation.x = Math.sin(time * 2.8 + i) * 0.075;
				head.position.y = 1.38 + Math.sin(time * 3 + i) * 0.025;
			});
			hands.forEach((hand, i) => {
				hand.position.y =
					0.89 + Math.max(0, Math.sin(time * 12 + i * 2)) * 0.07;
			});
			eyes.forEach((eye, i) => {
				eye.scaling.y =
					(time + Math.floor(i / 2) * 0.7) % 4.2 < 0.12 ? 0.018 : 0.11;
			});
			codeLines.forEach((line, i) => {
				line.scaling.x = 0.4 + 0.6 * ((time * 0.5 + i * 0.17) % 1);
			});
			hologram.position.y = 2.45 + Math.sin(time * 1.4) * 0.13;
			hologram.rotation.y = Math.sin(time * 0.65) * 0.16;
			hubBars.forEach((bar, i) => {
				bar.scaling.x = 0.15 + 0.85 * ((time * 0.16 + i * 0.24) % 1);
			});
			halo.scaling.setAll(1 + Math.sin(time * 2.2) * 0.08);
			haloMaterial.emissiveColor.set(
				0.18,
				0.65 + Math.sin(time * 2.2) * 0.2,
				0.8,
			);
			transfers.forEach(({ carrier, start, end, trail }, i) => {
				const progress = (time * 0.27 + i * 0.25) % 1;
				Vector3.LerpToRef(start, end, progress, carrier.position);
				carrier.position.y += Math.sin(progress * Math.PI) * 0.7;
				carrier.rotation.y = Math.sin(progress * Math.PI) * 0.6;
				carrier.rotation.z = Math.sin(progress * Math.PI * 2) * 0.12;
				carrier.scaling.setAll(0.8 + Math.sin(progress * Math.PI) * 0.5);
				trail.forEach((dot, j) => {
					const p = Math.max(0, progress - (j + 1) * 0.022);
					Vector3.LerpToRef(start, end, p, dot.position);
					dot.position.y += Math.sin(p * Math.PI) * 0.7;
				});
			});
			signals.forEach(({ mesh, start, end, phase }) => {
				Vector3.LerpToRef(start, end, (time * 0.5 + phase) % 1, mesh.position);
			});
			scene.render();
		};
		const frame = () => {
			const now = performance.now();
			const frameMs = 1000 / (compact.matches ? 24 : 40);
			if (now - lastFrame < frameMs) return;
			elapsed += Math.min(now - lastFrame, 100) / 1000;
			lastFrame = now;
			draw();
		};

		const syncPlayback = () => {
			const shouldRun = visible && !document.hidden && !motion.matches;
			if (shouldRun && !running) {
				lastFrame = performance.now();
				engine.runRenderLoop(frame);
				running = true;
			}
			if (!shouldRun && running) {
				engine.stopRenderLoop(frame);
				running = false;
			}
			if (!document.hidden) draw();
		};
		const resize = () => {
			engine.resize();
			const bounds = canvas.getBoundingClientRect();
			const target = anchor?.getBoundingClientRect() ?? bounds;
			camera.orthoLeft = -bounds.width / 200;
			camera.orthoRight = bounds.width / 200;
			camera.orthoTop = bounds.height / 200;
			camera.orthoBottom = -bounds.height / 200;
			// 桌面释放右侧留白来放大办公室；窄屏仍按完整平台宽度留出边距。
			const scale =
				Math.min(target.width, target.height) /
				(bounds.width >= 1280 ? 670 : 800);
			assembly.scaling.setAll(scale);
			// 模型原点在地板上，视觉中心约在其上方 0.95 单位；补偿这一高度，
			// 让完整办公室居于留白中心，而不是把地板中心误当成整个场景中心。
			assembly.position.set(
				(target.left + target.width / 2 - bounds.left - bounds.width / 2) / 100,
				-(target.top + target.height / 2 - bounds.top - bounds.height / 2) /
					100 -
					0.95 * scale,
				0,
			);
			draw();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(canvas);
		if (anchor) observer.observe(anchor);
		const visibility = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? false;
			syncPlayback();
		});
		visibility.observe(canvas);
		document.addEventListener("visibilitychange", syncPlayback);
		motion.addEventListener("change", syncPlayback);
		compact.addEventListener("change", syncPlayback);
		resize();
		syncPlayback();
		return {
			dispose: () => {
				engine.stopRenderLoop(frame);
				observer.disconnect();
				visibility.disconnect();
				document.removeEventListener("visibilitychange", syncPlayback);
				motion.removeEventListener("change", syncPlayback);
				compact.removeEventListener("change", syncPlayback);
				scene.dispose();
				engine.dispose();
			},
		};
	} catch (error) {
		// 初始化中途失败同样释放已分配的 GPU 资源，再由 React 边界显示静态降级。
		scene.dispose();
		engine.dispose();
		throw error;
	}
}
