package protocol

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// defaultIdempotencyTTL 是幂等记录的默认保留时长（design.md 模块 2：
// 「过期清理策略：超过 TTL（默认 7 天）的记录由定时任务清理」）。本包只用它
// 计算 Reserve 时写入的 expires_at，实际清理任务不在本文件范围内。
const defaultIdempotencyTTL = 7 * 24 * time.Hour

// ResponseSnapshot 是幂等记录中持久化的历史响应快照（design.md 模块 2「幂等键
// 与去重存储」、接口契约 `Commit(key, response ResponseSnapshot)`）。命中已提交
// 的幂等键时，调用方应把 StatusCode/Body 原样重放给客户端，不重新执行业务逻辑。
type ResponseSnapshot struct {
	StatusCode int             `json:"status_code"`
	Body       json.RawMessage `json:"body"`
}

// StoredRecord 是 IdempotencyStore.Reserve 命中已存在的幂等键时返回的当前状态。
type StoredRecord struct {
	// Committed 为 true 表示该记录已有真实响应快照（Snapshot 有效）；为 false
	// 表示该 key 仍被其他并发请求占用、业务逻辑尚未执行完毕（pending，尚未调用
	// Commit）。区分这两种状态是必要的：把「仍在处理中」误当成「已有历史响应」
	// 会让调用方把零值快照当作真实响应重放给客户端。
	Committed bool
	Snapshot  ResponseSnapshot // 仅 Committed 为 true 时有效。
}

// IdempotencyStore 是幂等记录的存储抽象，生产实现基于 idempotency_records 表
// （T-004 已建表：`idempotency_key` 唯一约束、`response_snapshot` 列 NOT NULL）。
// 本包只依赖该接口、不假设具体存储介质（与 verify.go 的 NonceStore 同一模式，
// design.md 模块 2「安全考虑」：具体存储实现与协议层分离）。
type IdempotencyStore interface {
	// Reserve 原子地"检查并占用"幂等键：
	//   - key 不存在时插入一条 pending 占位记录（表的 response_snapshot 列
	//     NOT NULL，实现须写入一个不等于任何合法 ResponseSnapshot 序列化结果的
	//     占位值，例如 JSON `null` 字面量，用于和真实快照区分），返回
	//     inserted=true。
	//   - key 已存在时不做任何写入，只回查当前行状态返回 inserted=false。
	//
	// 必须是原子操作（如 `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`
	// 后按影响行数判断是否插入成功），否则并发请求可能同时判断"不存在"并重复
	// 执行业务逻辑，幂等保证失效（对照 verify.go NonceStore.ReserveNonce 的同一
	// 要求）。
	//
	// callType 是本次调用已归一化的沙箱模式标记（design.md 模块 4 v2；来源于
	// VerifySignature 返回的 VerifyResult.CallType），插入新记录时必须原样写入
	// idempotency_records.call_type 列，不得丢弃——否则该列会全部落库为数据库
	// 默认值 production，沙箱调用无法在下游审计/统计中被正确排除（AC-006）。
	Reserve(ctx context.Context, key, operationType string, callType CallType, expiresAt time.Time) (record StoredRecord, inserted bool, err error)

	// CommitResponse 为先前 Reserve 返回 inserted=true 的 key 写入最终响应快照，
	// 将该记录从 pending 状态转为 committed。对不存在或已经是 committed 状态的
	// key 调用属于调用方用法错误，实现应返回 error 而不是静默覆盖或忽略
	// （AGENTS.md「正确用法应自然，错误用法应困难」）。
	CommitResponse(ctx context.Context, key string, snapshot ResponseSnapshot) error
}

// ErrIdempotencyKeyMissing 在对未经 Reserve（或已被清理过期）的 key 调用 Commit
// 时返回，提示调用方违反了 CheckAndReserve → 执行业务逻辑 → Commit 的既定顺序。
var ErrIdempotencyKeyMissing = errors.New("protocol: idempotency key was not reserved")

// Idempotency 组合幂等中间件所需的依赖，对外暴露 design.md 接口契约
// `CheckAndReserve(key) (existing, reserved)` / `Commit(key, response) error`
// （在 Go 惯用法下补充 ctx 与 error 返回，与 verify.go 的 Verifier 同一处理方式）。
// TTL 与 Now 为零值时分别回退到 defaultIdempotencyTTL 与 time.Now，Now 主要供
// 测试注入固定时钟。
type Idempotency struct {
	Store IdempotencyStore
	TTL   time.Duration
	Now   func() time.Time
}

func (r *Idempotency) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Idempotency) ttl() time.Duration {
	if r.TTL > 0 {
		return r.TTL
	}
	return defaultIdempotencyTTL
}

// CheckAndReserve 检查幂等键 key 是否已有历史结果，没有则原子占用它
// （design.md 模块 2、接口契约）。operationType 写入 idempotency_records.operation_type
// （NOT NULL 列），调用方必须提供，不做静默默认——未知操作类型没有安全的兜底值，
// 静默填充会让幂等记录的审计与按 operation_type 过滤（design.md 模块 4 下游消费
// 场景）失真。
//
// callType 对应 idempotency_records.call_type（design.md 模块 4 v2），调用方（如
// 幂等中间件）应直接传入 VerifySignature 返回的 VerifyResult.CallType，不需要
// 重新解析 X-Call-Type 头部或重新判断默认值——本方法复用 normalizeCallType
// （sign.go）做归一化与校验，与签名校验对"空值即 production"的理解保持一致
// （AGENTS.md「同一业务规则只保留一个权威实现」）。
//
// 返回值三种组合，调用方必须按此分支处理，不得只判断 reserved：
//   - existing != nil, reserved == false：key 命中已提交的历史响应，直接把
//     existing 原样返回给客户端，不重新执行业务逻辑。
//   - existing == nil, reserved == true：key 是本次新占用，调用方应执行业务
//     逻辑，成功后调用 Commit 写入快照；本方法不提供"释放占位"接口——业务逻辑
//     失败时的占位记录由 expires_at 过期兜底回收，避免引入尚无消费方约束、
//     容易被误用为"重试即可无副作用重跑"的额外接口。
//   - existing == nil, reserved == false, err == nil：key 被其他并发请求占用
//     且尚未提交（仍是 pending），调用方应向客户端返回"重复请求正在处理中"，
//     不得当作全新请求重新执行业务逻辑，也不得当作已有历史响应重放空快照。
func (r *Idempotency) CheckAndReserve(ctx context.Context, key, operationType string, callType CallType) (existing *ResponseSnapshot, reserved bool, err error) {
	if key == "" {
		return nil, false, errors.New("protocol: idempotency key must not be empty")
	}
	if operationType == "" {
		return nil, false, errors.New("protocol: idempotency operationType must not be empty")
	}
	normalizedCallType, err := normalizeCallType(callType)
	if err != nil {
		return nil, false, err
	}

	expiresAt := r.now().Add(r.ttl())
	record, inserted, err := r.Store.Reserve(ctx, key, operationType, normalizedCallType, expiresAt)
	if err != nil {
		return nil, false, err
	}
	if inserted {
		return nil, true, nil
	}
	if record.Committed {
		snapshot := record.Snapshot
		return &snapshot, false, nil
	}
	// 已存在但尚未提交：其他并发请求正占用同一个 key。
	return nil, false, nil
}

// Commit 为先前 CheckAndReserve 返回 reserved=true 的 key 写入最终响应快照
// （design.md 接口契约）。必须在业务逻辑成功执行后调用，且只能调用一次——
// 具体的"只能提交一次"约束由 IdempotencyStore.CommitResponse 的实现保证
// （单一权威位置，本方法不重复校验存储层已经负责的不变量）。
func (r *Idempotency) Commit(ctx context.Context, key string, snapshot ResponseSnapshot) error {
	if key == "" {
		return errors.New("protocol: idempotency key must not be empty")
	}
	return r.Store.CommitResponse(ctx, key, snapshot)
}
