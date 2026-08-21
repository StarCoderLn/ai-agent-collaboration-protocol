package protocol

import (
	"context"
	"time"
)

// defaultNonceRetention 是 used_nonces 的默认保留时长（design.md 模块 5 v3：
// 「覆盖 ±5 分钟签名时间窗口后留足缓冲，具体时长可配置，不与时间窗口本身耦合
// 成同一个常量」）。特意不直接复用 defaultTimeWindow（verify.go），因为两者
// 概念不同：TimeWindow 是签名时效性判定，Retention 是清理任务的数据保留期，
// 把它们耦合成同一个常量会让"调整签名容忍窗口"意外改变"nonce 表清理速度"。
const defaultNonceRetention = 24 * time.Hour

// IdempotencyPruner 删除已过期的 idempotency_records 行（design.md 模块 2：
// 「过期清理策略：超过 TTL 的记录由定时任务清理」）。与 IdempotencyStore
// （Reserve/CommitResponse，请求处理热路径）分开成独立接口——清理是后台定时
// 任务的关注点，不应该让请求处理路径的实现也被迫感知批量删除的方法，也不应
// 该反过来让清理任务依赖 Reserve/CommitResponse 的语义（AGENTS.md「不同层应
// 有不同抽象」）。生产实现按批次删除（如每批 1000 行）避免长事务锁表，具体
// 批次大小由实现决定，本接口不约束。
type IdempotencyPruner interface {
	// DeleteExpiredIdempotencyRecords 删除 expires_at 早于 before 的记录，返回
	// 实际删除的行数。天然幂等：重复以相同或更早的 before 调用只会删除"届时
	// 仍然过期"的行，不会因为记录已被删除而报错。
	DeleteExpiredIdempotencyRecords(ctx context.Context, before time.Time) (deleted int, err error)
}

// NoncePruner 删除早于保留期限的 used_nonces 行（design.md 模块 5 v3、模块 1
// 「安全考虑」：「nonce 存储需要唯一约束 + 过期清理，防止无限增长成为可用性
// 风险」）。与 NonceStore（ReserveNonce，验签热路径）分开的理由同
// IdempotencyPruner。
type NoncePruner interface {
	// DeleteExpiredNonces 删除 created_at 早于 before 的记录，返回实际删除的
	// 行数。天然幂等，理由同 DeleteExpiredIdempotencyRecords。
	DeleteExpiredNonces(ctx context.Context, before time.Time) (deleted int, err error)
}

// Cleanup 组合过期记录清理所需的依赖（design.md 模块 5 v3）。NonceRetention
// 与 Now 为零值时分别回退到 defaultNonceRetention 与 time.Now，Now 主要供
// 测试注入固定时钟——与 Idempotency/Verifier 的 Now 字段同一模式
// （AGENTS.md「同一业务规则只保留一个权威实现」，此处是"可注入时钟"这个测试
// 模式的权威实现方式，而非业务规则本身）。
//
// 本类型只提供清理函数，不内置调度器（cron/ticker）：具体多久跑一次、跑在
// 哪个进程里，是部署时的运维决策，不应该被编码在协议层（design.md 模块 5：
// 「本 feature 只提供清理函数本身，具体调度器接入点由部署时决定」）。
type Cleanup struct {
	Idempotency    IdempotencyPruner
	Nonces         NoncePruner
	NonceRetention time.Duration
	Now            func() time.Time
}

func (c *Cleanup) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Cleanup) nonceRetention() time.Duration {
	if c.NonceRetention > 0 {
		return c.NonceRetention
	}
	return defaultNonceRetention
}

// CleanupExpiredIdempotencyRecords 删除 expires_at 已过期（早于当前时间）的
// idempotency_records（AC-007）。expires_at 本身在 Idempotency.CheckAndReserve
// 写入时已经算好（Reserve 时的 TTL），本方法不重新计算 TTL，只按当前时间比对
// 已存储的 expires_at。
func (c *Cleanup) CleanupExpiredIdempotencyRecords(ctx context.Context) (int, error) {
	return c.Idempotency.DeleteExpiredIdempotencyRecords(ctx, c.now())
}

// CleanupExpiredNonces 删除 created_at 早于「当前时间 - 保留时长」的
// used_nonces（AC-007）。与幂等记录不同，nonce 本身不存储独立的过期时间——
// 保留时长由本方法在清理时计算，而不是 ReserveNonce 写入时预先算好，因为
// nonce 的"过期"只对清理任务本身有意义（验签阶段只关心 nonce 是否已被使用
// 过，不关心它多久之前被使用，见 verify.go NonceStore 注释），没有必要为了
// 清理这一个用途在写入路径上多存一列。
func (c *Cleanup) CleanupExpiredNonces(ctx context.Context) (int, error) {
	before := c.now().Add(-c.nonceRetention())
	return c.Nonces.DeleteExpiredNonces(ctx, before)
}
