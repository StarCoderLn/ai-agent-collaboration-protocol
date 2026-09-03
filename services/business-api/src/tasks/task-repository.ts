import type { QueryExecutor } from "../db/pool";
import {
	MAX_TASK_BUDGET_MINOR,
	MIN_TASK_BUDGET_MINOR,
} from "../platform/mvp-money";
import type {
	AcceptanceModeConfig,
	AssignmentModeConfig,
} from "../platform/visibility";
import type {
	EditableTaskDraft,
	TaskPricing,
} from "../platform/task-validation";
import type { TaskStatus } from "../platform/task-state";

export type StoredTask = Readonly<{
	id: string;
	publisherId: string;
	draft: EditableTaskDraft;
	categoryVersion: number | null;
	visibility: "public" | "private";
	assignmentMode: AssignmentModeConfig;
	acceptanceMode: AcceptanceModeConfig;
	status: TaskStatus;
	statusVersion: bigint;
	createdAt: Date;
	updatedAt: Date;
}>;

export type { EditableTaskDraft } from "../platform/task-validation";

export type TaskCreationContext = Readonly<{
	categoryVersion: number;
	attachmentLimit: Readonly<{
		maxFiles: number;
		maxFileSizeBytes: bigint;
		allowedMimeTypes: ReadonlySet<string>;
	}>;
	minExecutionPeriodMs: number;
	forbiddenTags: ReadonlySet<string>;
	canonicalByAlias: ReadonlyMap<string, string>;
	minBudgetMinor: bigint;
	maxBudgetMinor: bigint;
	feeConfig: Readonly<{
		version: string;
		feeBasisPoints: bigint;
		gasFallbackMinor: bigint;
	}>;
}>;

export interface TaskRepository {
	loadCreationContext(categoryId: string): Promise<TaskCreationContext | null>;
	createDraft(
		publisherId: string,
		input: Omit<
			StoredTask,
			| "id"
			| "publisherId"
			| "status"
			| "statusVersion"
			| "createdAt"
			| "updatedAt"
		>,
	): Promise<StoredTask>;
	findOwned(taskId: string, publisherId: string): Promise<StoredTask | null>;
	updateDraft(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
		input: Omit<
			StoredTask,
			| "id"
			| "publisherId"
			| "status"
			| "statusVersion"
			| "createdAt"
			| "updatedAt"
		>,
	): Promise<StoredTask | null>;
	updateModeSettings(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
		settings: Readonly<{
			visibility: "public" | "private";
			assignmentMode: AssignmentModeConfig;
			acceptanceMode: AcceptanceModeConfig;
		}>,
	): Promise<StoredTask | null>;
	updateMatchCriteria(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
		input: Readonly<{
			categoryId: string;
			categoryVersion: number;
			tags: readonly string[];
			deadline: Date;
		}>,
	): Promise<StoredTask | null>;
	submit(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
		canonicalTags: readonly string[],
		categoryVersion: number,
	): Promise<StoredTask | null>;
	/** 仅隐藏尚未进入资金流程的任务；关联工作流和审计记录必须继续保留。 */
	archive(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
	): Promise<StoredTask | null>;
}

export type TaskCategory = Readonly<{
	id: string;
	parentId: string | null;
	name: string;
	slug: string;
	version: number;
}>;
export type TaskTagSuggestion = Readonly<{
	canonicalName: string;
	matchedAlias: string | null;
}>;

export interface TaskTaxonomyRepository {
	listCategories(): Promise<readonly TaskCategory[]>;
	suggestTags(
		query: string,
		limit: number,
	): Promise<readonly TaskTagSuggestion[]>;
}

export type TaskMarketFilters = Readonly<{
	keyword: string;
	categoryId: string | null;
	tag: string | null;
	status: TaskStatus | null;
	limit: number;
	offset: number;
}>;

export type TaskMarketPage = Readonly<{
	tasks: readonly StoredTask[];
	total: number;
}>;

export type TaskAccessRecord = Readonly<{
	task: StoredTask;
	assignedProviderWallets: readonly string[];
}>;

export interface TaskReadRepository {
	findForAudience(taskId: string): Promise<TaskAccessRecord | null>;
	listPublicMarket(filters: TaskMarketFilters): Promise<TaskMarketPage>;
	/** 发布者工作台读取包含草稿和私密任务；调用方必须先从可信会话取得 publisherId。 */
	listOwnedTasks(
		publisherId: string,
		limit: number,
		offset: number,
	): Promise<readonly StoredTask[]>;
	readMarketStats(): Promise<Readonly<Record<string, number>>>;
	readPublisherStats(
		publisherId: string,
	): Promise<Readonly<Record<string, number>>>;
}

interface ContextRow {
	category_version: number;
	max_files: number | null;
	max_file_size_bytes: string | null;
	allowed_mime_types: string[] | null;
	min_execution_period_seconds: number;
	fee_version: string;
	fee_basis_points: number;
	gas_fallback_minor: string;
}

interface TagRow {
	canonical_name: string;
	synonyms: string[];
	forbidden: boolean;
}

interface TaskRow {
	id: string;
	publisher_id: string;
	title: string;
	description: string;
	acceptance_criteria: string;
	deliverable_format: string;
	category_id: string | null;
	category_version: number | null;
	tag_names: string[];
	pricing_type: "fixed" | "range" | null;
	budget_min_minor: string | null;
	budget_max_minor: string | null;
	currency: string;
	deadline: Date | null;
	required_capability: string;
	attachments: Array<{
		name: string;
		mimeType: string;
		sizeBytes: string;
		storageRef: string;
	}>;
	visibility: "public" | "private";
	assignment_mode_config: unknown;
	acceptance_mode: "manual" | "automatic";
	acceptor_config: unknown;
	status: TaskStatus;
	status_version: string;
	created_at: Date;
	updated_at: Date;
}

const DEFAULT_ATTACHMENT_LIMIT = {
	maxFiles: 10,
	maxFileSizeBytes: 20n * 1_048_576n,
	allowedMimeTypes: new Set([
		"application/pdf",
		"image/png",
		"image/jpeg",
		"text/plain",
	]),
} as const;

/** PostgreSQL 仓储隐藏 JSON/BigInt 编码和多表配置查询，领域服务只看到可信类型。 */
export class PgTaskRepository
	implements TaskRepository, TaskTaxonomyRepository, TaskReadRepository
{
	constructor(private readonly db: QueryExecutor) {}

	async loadCreationContext(
		categoryId: string,
	): Promise<TaskCreationContext | null> {
		const context = await this.db.query<ContextRow>(
			`SELECT c.version AS category_version,
              l.max_files, l.max_file_size_bytes::text, l.allowed_mime_types,
              timing.min_execution_period_seconds,
              fee.version AS fee_version, fee.fee_basis_points, fee.gas_fallback_minor::text
         FROM categories c
         CROSS JOIN task_timing_config timing
         CROSS JOIN platform_fee_config fee
         LEFT JOIN attachment_category_limits l ON l.category_id = c.id
        WHERE c.id = $1 AND c.active = TRUE AND fee.active = TRUE`,
			[categoryId],
		);
		const row = context.rows[0];
		if (row === undefined) return null;
		const tags = await this.db.query<TagRow>(
			`SELECT canonical_name, synonyms, forbidden FROM tags`,
			[],
		);
		const canonicalByAlias = new Map<string, string>();
		const forbiddenTags = new Set<string>();
		for (const tag of tags.rows) {
			const canonical = tag.canonical_name.toLocaleLowerCase();
			canonicalByAlias.set(canonical, canonical);
			for (const alias of tag.synonyms)
				canonicalByAlias.set(alias.toLocaleLowerCase(), canonical);
			if (tag.forbidden) forbiddenTags.add(canonical);
		}
		const attachmentLimit =
			row.max_file_size_bytes === null ||
			row.allowed_mime_types === null ||
			row.max_files === null
				? DEFAULT_ATTACHMENT_LIMIT
				: {
						maxFiles: row.max_files,
						maxFileSizeBytes: BigInt(row.max_file_size_bytes),
						allowedMimeTypes: new Set(
							row.allowed_mime_types.map((mime) => mime.toLocaleLowerCase()),
						),
					};
		return {
			categoryVersion: row.category_version,
			attachmentLimit,
			minExecutionPeriodMs: row.min_execution_period_seconds * 1_000,
			forbiddenTags,
			canonicalByAlias,
			minBudgetMinor: MIN_TASK_BUDGET_MINOR,
			maxBudgetMinor: MAX_TASK_BUDGET_MINOR,
			feeConfig: {
				version: row.fee_version,
				feeBasisPoints: BigInt(row.fee_basis_points),
				gasFallbackMinor: BigInt(row.gas_fallback_minor),
			},
		};
	}

	async createDraft(
		publisherId: string,
		input: Omit<
			StoredTask,
			| "id"
			| "publisherId"
			| "status"
			| "statusVersion"
			| "createdAt"
			| "updatedAt"
		>,
	): Promise<StoredTask> {
		const [budgetMin, budgetMax, pricingType] = pricingColumns(
			input.draft.pricing,
		);
		const result = await this.db.query<TaskRow>(
			`INSERT INTO tasks (
         publisher_id, title, description, acceptance_criteria, deliverable_format,
         category_id, category_version, tag_names, pricing_type, budget_min_minor,
         budget_max_minor, currency, deadline, required_capability, attachments,
         visibility, assignment_mode_config, acceptance_mode, acceptor_config
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19::jsonb
       ) RETURNING *`,
			[
				publisherId,
				input.draft.title,
				input.draft.description,
				input.draft.acceptanceCriteria,
				input.draft.deliverableFormat,
				input.draft.categoryId,
				input.categoryVersion,
				input.draft.tags,
				pricingType,
				budgetMin?.toString() ?? null,
				budgetMax?.toString() ?? null,
				input.draft.currency,
				input.draft.deadline,
				input.draft.requiredCapability,
				JSON.stringify(
					input.draft.attachments.map((attachment) => ({
						...attachment,
						sizeBytes: attachment.sizeBytes.toString(),
					})),
				),
				input.visibility,
				JSON.stringify(serializeAssignmentMode(input.assignmentMode)),
				input.acceptanceMode.mode,
				JSON.stringify(
					input.acceptanceMode.mode === "automatic"
						? {
								acceptorId: input.acceptanceMode.acceptorId,
								ruleVersion: input.acceptanceMode.ruleVersion,
							}
						: {},
				),
			],
		);
		return mapTaskRow(requiredRow(result.rows[0]));
	}

	async findOwned(
		taskId: string,
		publisherId: string,
	): Promise<StoredTask | null> {
		const result = await this.db.query<TaskRow>(
			`SELECT * FROM tasks
        WHERE id = $1 AND lower(publisher_id) = lower($2) AND archived_at IS NULL`,
			[taskId, publisherId],
		);
		return result.rows[0] === undefined ? null : mapTaskRow(result.rows[0]);
	}

	async updateDraft(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
		input: Omit<
			StoredTask,
			| "id"
			| "publisherId"
			| "status"
			| "statusVersion"
			| "createdAt"
			| "updatedAt"
		>,
	): Promise<StoredTask | null> {
		const [budgetMin, budgetMax, pricingType] = pricingColumns(
			input.draft.pricing,
		);
		const result = await this.db.query<TaskRow>(
			`UPDATE tasks SET
         title=$4, description=$5, acceptance_criteria=$6, deliverable_format=$7,
         category_id=$8, category_version=$9, tag_names=$10, pricing_type=$11,
         budget_min_minor=$12, budget_max_minor=$13, currency=$14, deadline=$15,
         required_capability=$16, attachments=$17::jsonb, visibility=$18,
         assignment_mode_config=$19::jsonb, acceptance_mode=$20, acceptor_config=$21::jsonb,
         status_version=status_version + 1
       WHERE id=$1 AND lower(publisher_id)=lower($2)
         AND status='draft' AND status_version=$3
       RETURNING *`,
			[
				taskId,
				publisherId,
				expectedVersion.toString(),
				input.draft.title,
				input.draft.description,
				input.draft.acceptanceCriteria,
				input.draft.deliverableFormat,
				input.draft.categoryId,
				input.categoryVersion,
				input.draft.tags,
				pricingType,
				budgetMin?.toString() ?? null,
				budgetMax?.toString() ?? null,
				input.draft.currency,
				input.draft.deadline,
				input.draft.requiredCapability,
				JSON.stringify(
					input.draft.attachments.map((attachment) => ({
						...attachment,
						sizeBytes: attachment.sizeBytes.toString(),
					})),
				),
				input.visibility,
				JSON.stringify(serializeAssignmentMode(input.assignmentMode)),
				input.acceptanceMode.mode,
				JSON.stringify(
					input.acceptanceMode.mode === "automatic"
						? {
								acceptorId: input.acceptanceMode.acceptorId,
								ruleVersion: input.acceptanceMode.ruleVersion,
							}
						: {},
				),
			],
		);
		return result.rows[0] === undefined ? null : mapTaskRow(result.rows[0]);
	}

	async updateModeSettings(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
		settings: Readonly<{
			visibility: "public" | "private";
			assignmentMode: AssignmentModeConfig;
			acceptanceMode: AcceptanceModeConfig;
		}>,
	): Promise<StoredTask | null> {
		const result = await this.db.query<TaskRow>(
			`UPDATE tasks
          SET visibility=$4, assignment_mode_config=$5::jsonb,
              acceptance_mode=$6, acceptor_config=$7::jsonb,
              status_version=status_version + 1
        WHERE id=$1 AND lower(publisher_id)=lower($2) AND status_version=$3
      RETURNING *`,
			[
				taskId,
				publisherId,
				expectedVersion.toString(),
				settings.visibility,
				JSON.stringify(serializeAssignmentMode(settings.assignmentMode)),
				settings.acceptanceMode.mode,
				JSON.stringify(
					settings.acceptanceMode.mode === "automatic"
						? {
								acceptorId: settings.acceptanceMode.acceptorId,
								ruleVersion: settings.acceptanceMode.ruleVersion,
							}
						: {},
				),
			],
		);
		return result.rows[0] === undefined ? null : mapTaskRow(result.rows[0]);
	}

	async updateMatchCriteria(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
		input: Readonly<{
			categoryId: string;
			categoryVersion: number;
			tags: readonly string[];
			deadline: Date;
		}>,
	): Promise<StoredTask | null> {
		const result = await this.db.query<TaskRow>(
			`UPDATE tasks
          SET category_id=$4, category_version=$5, tag_names=$6, deadline=$7,
              status_version=status_version + 1
        WHERE id=$1 AND lower(publisher_id)=lower($2)
          AND status='matching' AND status_version=$3
      RETURNING *`,
			[
				taskId,
				publisherId,
				expectedVersion.toString(),
				input.categoryId,
				input.categoryVersion,
				input.tags,
				input.deadline,
			],
		);
		return result.rows[0] === undefined ? null : mapTaskRow(result.rows[0]);
	}

	async submit(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
		canonicalTags: readonly string[],
		categoryVersion: number,
	): Promise<StoredTask | null> {
		const result = await this.db.query<TaskRow>(
			`UPDATE tasks
          SET status = 'planning', status_version = status_version + 1,
              tag_names = $4, category_version = $5
        WHERE id = $1 AND lower(publisher_id) = lower($2)
          AND status = 'draft' AND status_version = $3
      RETURNING *`,
			[
				taskId,
				publisherId,
				expectedVersion.toString(),
				canonicalTags,
				categoryVersion,
			],
		);
		return result.rows[0] === undefined ? null : mapTaskRow(result.rows[0]);
	}

	async archive(
		taskId: string,
		publisherId: string,
		expectedVersion: bigint,
	): Promise<StoredTask | null> {
		const result = await this.db.query<TaskRow>(
			`UPDATE tasks
          SET archived_at = now(), updated_at = now(), status_version = status_version + 1
        WHERE id = $1 AND lower(publisher_id) = lower($2)
          AND status_version = $3 AND archived_at IS NULL
          AND status IN ('draft', 'planning')
      RETURNING *`,
			[taskId, publisherId, expectedVersion.toString()],
		);
		return result.rows[0] === undefined ? null : mapTaskRow(result.rows[0]);
	}

	async listCategories(): Promise<readonly TaskCategory[]> {
		const result = await this.db.query<{
			id: string;
			parent_id: string | null;
			name: string;
			slug: string;
			version: number;
		}>(
			`SELECT id, parent_id, name, slug, version
         FROM categories WHERE active = TRUE
        ORDER BY parent_id NULLS FIRST, name, id`,
			[],
		);
		return result.rows.map((row) => ({
			id: row.id,
			parentId: row.parent_id,
			name: row.name,
			slug: row.slug,
			version: row.version,
		}));
	}

	async suggestTags(
		query: string,
		limit: number,
	): Promise<readonly TaskTagSuggestion[]> {
		const escaped = query.replace(/[\\%_]/g, (character) => `\\${character}`);
		const result = await this.db.query<{
			canonical_name: string;
			matched_alias: string | null;
		}>(
			`SELECT canonical_name,
              (SELECT alias FROM unnest(synonyms) alias
                WHERE alias ILIKE $1 ESCAPE '\\' ORDER BY length(alias), alias LIMIT 1) AS matched_alias
         FROM tags
        WHERE forbidden = FALSE
          AND (canonical_name ILIKE $1 ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM unnest(synonyms) alias WHERE alias ILIKE $1 ESCAPE '\\'))
        ORDER BY CASE WHEN lower(canonical_name) = lower($2) THEN 0 ELSE 1 END,
                 length(canonical_name), canonical_name
        LIMIT $3`,
			[`%${escaped}%`, query, limit],
		);
		return result.rows.map((row) => ({
			canonicalName: row.canonical_name,
			matchedAlias: row.matched_alias,
		}));
	}

	async findForAudience(taskId: string): Promise<TaskAccessRecord | null> {
		const result = await this.db.query<
			TaskRow & { assigned_provider_wallets: string[] }
		>(
			`SELECT t.*,
              COALESCE(array_agg(DISTINCT a.provider_wallet_address)
                FILTER (WHERE a.provider_wallet_address IS NOT NULL), '{}') AS assigned_provider_wallets
         FROM tasks t
         LEFT JOIN task_assignments ta
           ON ta.task_id=t.id AND ta.status IN ('pending_ack','accepted')
         LEFT JOIN agents a ON a.id=ta.agent_id
        WHERE t.id=$1 AND t.archived_at IS NULL
        GROUP BY t.id`,
			[taskId],
		);
		const row = result.rows[0];
		return row === undefined
			? null
			: {
					task: mapTaskRow(row),
					assignedProviderWallets: row.assigned_provider_wallets,
				};
	}

	async listPublicMarket(
		filters: TaskMarketFilters,
	): Promise<TaskMarketPage> {
		const result = await this.db.query<TaskRow & { total_count: string }>(
			`SELECT tasks.*,count(*) OVER()::text AS total_count FROM tasks
        WHERE visibility='public'
          AND archived_at IS NULL
          AND status NOT IN ('draft','planning','awaiting_escrow')
          AND ($1 = '' OR title ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
          AND ($2::uuid IS NULL OR category_id=$2)
          AND ($3::text IS NULL OR $3=ANY(tag_names))
          AND ($4::text IS NULL OR status=$4)
        ORDER BY created_at DESC, id
        LIMIT $5 OFFSET $6`,
			[
				filters.keyword,
				filters.categoryId,
				filters.tag,
				filters.status,
				filters.limit,
				filters.offset,
			],
		);
		return {
			tasks: result.rows.map(mapTaskRow),
			// 与 Agent 目录保持一致：列表和总数来自同一查询快照，分页不会漏算筛选条件。
			total:
				result.rows[0] === undefined
					? 0
					: Number.parseInt(result.rows[0].total_count, 10),
		};
	}

	async listOwnedTasks(
		publisherId: string,
		limit: number,
		offset: number,
	): Promise<readonly StoredTask[]> {
		const result = await this.db.query<TaskRow>(
			`SELECT * FROM tasks
        WHERE lower(publisher_id)=lower($1)
          AND archived_at IS NULL
        ORDER BY updated_at DESC,id
        LIMIT $2 OFFSET $3`,
			[publisherId, limit, offset],
		);
		return result.rows.map(mapTaskRow);
	}

	/** 市场统计只聚合公开、已进入交易流程的任务，不接受发布者筛选条件。 */
	async readMarketStats(): Promise<Readonly<Record<string, number>>> {
		const result = await this.db.query<{
			total: string;
			matching: string;
			executing: string;
			execution_failed: string;
			awaiting_review: string;
			disputed: string;
		}>(
			`SELECT count(*)::text AS total,
              count(*) FILTER (WHERE status IN ('matching','awaiting_agent_acceptance'))::text AS matching,
              count(*) FILTER (WHERE status IN ('executing','rework'))::text AS executing,
			  count(*) FILTER (WHERE status='execution_failed')::text AS execution_failed,
              count(*) FILTER (WHERE status='awaiting_review')::text AS awaiting_review,
              count(*) FILTER (WHERE status='disputed')::text AS disputed
         FROM tasks
        WHERE visibility='public' AND archived_at IS NULL
          AND status NOT IN ('draft','planning','awaiting_escrow')`,
			[],
		);
		return numericStats(requiredStatsRow(result.rows[0]));
	}

	/** 工作台统计只按当前发布者聚合，故意不复用公开市场查询，避免两个口径互相污染。 */
	async readPublisherStats(
		publisherId: string,
	): Promise<Readonly<Record<string, number>>> {
		const result = await this.db.query<{
			total: string;
			pending: string;
			executing: string;
			awaiting_review: string;
			completed: string;
			disputed: string;
		}>(
			`SELECT count(*)::text AS total,
			  count(*) FILTER (WHERE status IN ('draft','planning','awaiting_escrow','matching','awaiting_agent_acceptance','pending_settlement','execution_failed'))::text AS pending,
              count(*) FILTER (WHERE status IN ('executing','rework'))::text AS executing,
              count(*) FILTER (WHERE status='awaiting_review')::text AS awaiting_review,
              count(*) FILTER (WHERE status IN ('settled','refunded'))::text AS completed,
              count(*) FILTER (WHERE status='disputed')::text AS disputed
         FROM tasks
        WHERE lower(publisher_id)=lower($1) AND archived_at IS NULL`,
			[publisherId],
		);
		return numericStats(requiredStatsRow(result.rows[0]));
	}
}

function pricingColumns(
	pricing: TaskPricing | null,
): readonly [bigint | null, bigint | null, TaskPricing["type"] | null] {
	if (pricing === null) return [null, null, null];
	return pricing.type === "fixed"
		? [pricing.amountMinor, pricing.amountMinor, pricing.type]
		: [pricing.minAmountMinor, pricing.maxAmountMinor, pricing.type];
}

function serializeAssignmentMode(mode: AssignmentModeConfig) {
	return mode.mode === "manual"
		? { mode: "manual" }
		: { ...mode, priceCapMinor: mode.priceCapMinor.toString() };
}

function mapTaskRow(row: TaskRow): StoredTask {
	const pricing: TaskPricing | null =
		row.pricing_type === null
			? null
			: row.pricing_type === "fixed"
				? {
						type: "fixed",
						amountMinor: BigInt(requiredString(row.budget_min_minor)),
					}
				: {
						type: "range",
						minAmountMinor: BigInt(requiredString(row.budget_min_minor)),
						maxAmountMinor: BigInt(requiredString(row.budget_max_minor)),
					};
	const assignment = asRecord(row.assignment_mode_config);
	const assignmentMode: AssignmentModeConfig =
		assignment.mode === "automatic"
			? {
					mode: "automatic",
					priceCapMinor: BigInt(requiredString(assignment.priceCapMinor)),
					rankingBasis: requiredString(assignment.rankingBasis),
					fallbackOnFail:
						assignment.fallbackOnFail === "cancel" ? "cancel" : "manual",
				}
			: { mode: "manual" };
	const acceptor = asRecord(row.acceptor_config);
	const acceptanceMode: AcceptanceModeConfig =
		row.acceptance_mode === "automatic"
			? {
					mode: "automatic",
					acceptorId: requiredString(acceptor.acceptorId),
					ruleVersion: requiredString(acceptor.ruleVersion),
				}
			: { mode: "manual" };
	return {
		id: row.id,
		publisherId: row.publisher_id,
		draft: {
			title: row.title,
			description: row.description,
			acceptanceCriteria: row.acceptance_criteria,
			deliverableFormat: row.deliverable_format,
			categoryId: row.category_id,
			tags: row.tag_names,
			pricing,
			currency: row.currency,
			deadline: row.deadline,
			requiredCapability: row.required_capability,
			attachments: row.attachments.map((attachment) => ({
				...attachment,
				sizeBytes: BigInt(attachment.sizeBytes),
			})),
		},
		categoryVersion: row.category_version,
		visibility: row.visibility,
		assignmentMode,
		acceptanceMode,
		status: row.status,
		statusVersion: BigInt(row.status_version),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function requiredString(value: unknown): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error("INVALID_TASK_MODE_STORAGE");
	return value;
}
function requiredRow(row: TaskRow | undefined): TaskRow {
	if (row === undefined) throw new Error("TASK_INSERT_DID_NOT_RETURN_ROW");
	return row;
}

function requiredStatsRow<Row extends Record<string, string>>(
	row: Row | undefined,
): Row {
	if (row === undefined) throw new Error("TASK_STATS_QUERY_DID_NOT_RETURN_ROW");
	return row;
}

function numericStats(
	row: Record<string, string>,
): Readonly<Record<string, number>> {
	return Object.fromEntries(
		Object.entries(row).map(([name, value]) => [
			name,
			Number.parseInt(value, 10),
		]),
	);
}
