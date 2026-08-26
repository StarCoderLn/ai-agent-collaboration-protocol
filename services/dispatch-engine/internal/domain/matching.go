package domain

import (
	"errors"
	"math"
	"sort"
	"time"
)

type AgentCandidate struct {
	ID                      string
	Name                    string
	CategoryID              string
	Tags                    []string
	State                   AgentState
	PriceMinor              int64
	Currency                string
	Score                   float64
	Completed               int
	EstimatedDuration       time.Duration
	ResponseMinutes         int
	CurrentLoad             int
	RatingSampleSize        int
	PriorWeight             int
	ProbationBudgetCapMinor int64
}

type MatchTask struct {
	ID          string
	CategoryID  string
	Tags        []string
	BudgetMinor int64
	Currency    string
	Deadline    time.Time
}
type EligibilityReason string

const (
	Eligible                EligibilityReason = "eligible"
	WrongCategory           EligibilityReason = "wrong_category"
	InactiveAgent           EligibilityReason = "inactive_agent"
	OverBudget              EligibilityReason = "over_budget"
	CurrencyMismatch        EligibilityReason = "currency_mismatch"
	DeadlinePassed          EligibilityReason = "deadline_passed"
	CannotMeetDeadline      EligibilityReason = "cannot_meet_deadline"
	ProbationBudgetExceeded EligibilityReason = "probation_budget_exceeded"
)

// ValidateHardConstraints 是资格过滤的单一权威入口。受控上线不是冗余字段，直接
// 由评分样本量与当前规则 prior weight 比较得出。
func ValidateHardConstraints(task MatchTask, agent AgentCandidate, now time.Time) EligibilityReason {
	if agent.CategoryID != task.CategoryID {
		return WrongCategory
	}
	if agent.State.Status != AgentActive {
		return InactiveAgent
	}
	if agent.Currency != task.Currency {
		return CurrencyMismatch
	}
	if agent.PriceMinor > task.BudgetMinor {
		return OverBudget
	}
	if !task.Deadline.After(now) {
		return DeadlinePassed
	}
	if agent.EstimatedDuration <= 0 || agent.EstimatedDuration > task.Deadline.Sub(now) {
		return CannotMeetDeadline
	}
	if agent.RatingSampleSize < agent.PriorWeight && task.BudgetMinor > agent.ProbationBudgetCapMinor {
		return ProbationBudgetExceeded
	}
	return Eligible
}

type RankedCandidate struct {
	Agent       AgentCandidate
	MatchedTags []string
	// RankScore 使用整数避免浮点排序在不同平台/版本间出现边界差异；Score 原始值只在
	// 进入排序前量化一次。相同输入和规则版本会得到逐位相同的结果。
	RankScore int64
}

type RankingRules struct {
	Version             string
	TagMatchWeight      int64
	QualityWeight       int64
	PriceWeight         int64
	ResponseSpeedWeight int64
	LoadWeight          int64
	CompletedWeight     int64
}

type DistributionRecord struct {
	TaskID        string
	RuleVersion   string
	Candidates    []RankedCandidate
	FilterReasons map[string]EligibilityReason
}

// FilterByCategory 是匹配管道第一阶段。原因按 Agent ID 留痕，不用“过滤后为空”掩盖根因。
func FilterByCategory(task MatchTask, agents []AgentCandidate) ([]AgentCandidate, map[string]EligibilityReason) {
	filtered := make([]AgentCandidate, 0, len(agents))
	reasons := make(map[string]EligibilityReason)
	for _, agent := range agents {
		if agent.CategoryID != task.CategoryID {
			reasons[agent.ID] = WrongCategory
			continue
		}
		filtered = append(filtered, agent)
	}
	return filtered, reasons
}

// FilterByEligibility 复用 ValidateHardConstraints，不能假定分类阶段一定先被调用。
func FilterByEligibility(task MatchTask, agents []AgentCandidate, now time.Time) ([]AgentCandidate, map[string]EligibilityReason) {
	filtered := make([]AgentCandidate, 0, len(agents))
	reasons := make(map[string]EligibilityReason)
	for _, agent := range agents {
		reason := ValidateHardConstraints(task, agent, now)
		if reason != Eligible {
			reasons[agent.ID] = reason
			continue
		}
		filtered = append(filtered, agent)
	}
	return filtered, reasons
}

// MatchByTags 只计算可解释的交集，不做隐式过滤；零标签命中的候选仍可由排序规则降权。
func MatchByTags(task MatchTask, agents []AgentCandidate) []RankedCandidate {
	matched := make([]RankedCandidate, 0, len(agents))
	for _, agent := range agents {
		matched = append(matched, RankedCandidate{Agent: agent, MatchedTags: intersectTags(task.Tags, agent.Tags)})
	}
	return matched
}

// RankByRules 是纯函数，所有权重均来自显式版本化规则，不读取时间或全局配置。
func RankByRules(task MatchTask, candidates []RankedCandidate, rules RankingRules) ([]RankedCandidate, error) {
	if err := validateRankingRules(rules); err != nil {
		return nil, err
	}
	ranked := append([]RankedCandidate(nil), candidates...)
	for index := range ranked {
		ranked[index].RankScore = computeRankScore(task, ranked[index], rules)
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].RankScore == ranked[j].RankScore {
			return ranked[i].Agent.ID < ranked[j].Agent.ID
		}
		return ranked[i].RankScore > ranked[j].RankScore
	})
	return ranked, nil
}

// MatchCandidates 编排四阶段管道；任一规则无效都显式失败，绝不退回硬编码排序。
func MatchCandidates(task MatchTask, agents []AgentCandidate, now time.Time, rules RankingRules) (DistributionRecord, error) {
	categoryMatches, categoryReasons := FilterByCategory(task, agents)
	eligible, eligibilityReasons := FilterByEligibility(task, categoryMatches, now)
	matched := MatchByTags(task, eligible)
	ranked, err := RankByRules(task, matched, rules)
	if err != nil {
		return DistributionRecord{}, err
	}
	record := DistributionRecord{TaskID: task.ID, RuleVersion: rules.Version, Candidates: ranked, FilterReasons: categoryReasons}
	for agentID, reason := range eligibilityReasons {
		record.FilterReasons[agentID] = reason
	}
	return record, nil
}

func computeRankScore(task MatchTask, candidate RankedCandidate, rules RankingRules) int64 {
	const featureScale int64 = 10_000
	tagScore := int64(0)
	if len(task.Tags) > 0 {
		tagScore = int64(len(candidate.MatchedTags)) * featureScale / int64(len(task.Tags))
	}
	qualityScore := int64(math.Round(candidate.Agent.Score * 2_000)) // 0–5 分映射到 0–10000。
	priceScore := int64(0)
	if task.BudgetMinor > 0 && candidate.Agent.PriceMinor <= task.BudgetMinor {
		priceScore = (task.BudgetMinor - candidate.Agent.PriceMinor) * featureScale / task.BudgetMinor
	}
	responseScore := featureScale / int64(1+max(candidate.Agent.ResponseMinutes, 0))
	loadScore := featureScale / int64(1+max(candidate.Agent.CurrentLoad, 0))
	completedScore := int64(min(max(candidate.Agent.Completed, 0), 1_000)) * 10
	return tagScore*rules.TagMatchWeight +
		qualityScore*rules.QualityWeight +
		priceScore*rules.PriceWeight +
		responseScore*rules.ResponseSpeedWeight +
		loadScore*rules.LoadWeight +
		completedScore*rules.CompletedWeight
}

func validateRankingRules(rules RankingRules) error {
	if rules.Version == "" {
		return errors.New("ranking rule version must not be empty")
	}
	weights := []int64{rules.TagMatchWeight, rules.QualityWeight, rules.PriceWeight, rules.ResponseSpeedWeight, rules.LoadWeight, rules.CompletedWeight}
	var total int64
	for _, weight := range weights {
		if weight < 0 {
			return errors.New("ranking weights must not be negative")
		}
		total += weight
	}
	if total == 0 {
		return errors.New("at least one ranking weight must be positive")
	}
	return nil
}

func intersectTags(taskTags, agentTags []string) []string {
	set := map[string]struct{}{}
	for _, tag := range taskTags {
		set[tag] = struct{}{}
	}
	var out []string
	for _, tag := range agentTags {
		if _, ok := set[tag]; ok {
			out = append(out, tag)
		}
	}
	sort.Strings(out)
	return out
}
