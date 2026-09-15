package temporaltraining

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Repository 是训练编排的持久化边界：数据窗口、运行状态和模型注册均由数据库实现。
type Repository interface {
	PrepareDataset(context.Context, PrepareInput, string) (PreparedDataset, error)
	RegisterModel(context.Context, TrainedModel, time.Time) error
	FailTraining(context.Context, string, string, time.Time) error
}

// Trainer 隐藏 Python 进程和模型制品格式，Workflow 只依赖确定性的阶段结果。
type Trainer interface {
	Train(context.Context, PreparedDataset) (TrainedModel, error)
}

// Activities 承载所有非确定性副作用。WorkDir 只保存可重建数据集，Now 用于测试。
type Activities struct {
	Repository Repository
	Trainer    Trainer
	WorkDir    string
	Now        func() time.Time
}

func (a *Activities) PrepareDataset(ctx context.Context, input PrepareInput) (PreparedDataset, error) {
	// 文件名只由窗口和特征版本决定，同一 Workflow 重试会落到同一路径而不会制造副本。
	if a == nil || a.Repository == nil || a.WorkDir == "" || input.WorkflowID == "" || !input.WindowEnd.After(input.WindowStart) {
		return PreparedDataset{}, errors.New("matching training preparation is not configured")
	}
	fingerprint := sha256.Sum256([]byte(input.WindowStart.UTC().Format(time.RFC3339Nano) + "\x00" + input.WindowEnd.UTC().Format(time.RFC3339Nano) + "\x00matching-v2.features.v1"))
	return a.Repository.PrepareDataset(ctx, input, filepath.Join(a.WorkDir, hex.EncodeToString(fingerprint[:])+".jsonl"))
}

func (a *Activities) TrainModel(ctx context.Context, prepared PreparedDataset) (TrainedModel, error) {
	// 样本门槛已经在 PrepareDataset 处理；本阶段只执行可替换的训练实现。
	if a == nil || a.Trainer == nil {
		return TrainedModel{}, errors.New("matching trainer is not configured")
	}
	return a.Trainer.Train(ctx, prepared)
}

func (a *Activities) RegisterModel(ctx context.Context, model TrainedModel) error {
	// 注册只产生 candidate，不在训练完成时自动切换 shadow 或 active 流量。
	if a == nil || a.Repository == nil {
		return errors.New("matching model registry is not configured")
	}
	return a.Repository.RegisterModel(ctx, model, a.now())
}

func (a *Activities) FailTraining(ctx context.Context, input FailureInput) error {
	// 失败 Activity 使用稳定 code 更新已有 run，避免原始 Python 错误进入长期审计字段。
	if a == nil || a.Repository == nil || input.RunID == "" || input.Code == "" {
		return errors.New("matching training failure is invalid")
	}
	return a.Repository.FailTraining(ctx, input.RunID, input.Code, a.now())
}

func (a *Activities) now() time.Time {
	// 所有持久化时间统一为 UTC，避免 Worker 所在机器时区改变运行顺序。
	if a.Now != nil {
		return a.Now().UTC()
	}
	return time.Now().UTC()
}

// CommandTrainer 通过参数数组启动项目自有 CLI，不经过 shell，也不会解释数据库内容
// 中的反引号或命令替换。缓存固定在 /tmp，避免再次增长用户目录中的 Rust/Python 缓存。
type CommandTrainer struct {
	ServiceDir  string
	ArtifactDir string
	UVCacheDir  string
}

func (t CommandTrainer) Train(ctx context.Context, prepared PreparedDataset) (TrainedModel, error) {
	if t.ServiceDir == "" || t.ArtifactDir == "" || prepared.RunID == "" || prepared.DatasetPath == "" {
		return TrainedModel{}, errors.New("matching command trainer is not configured")
	}
	command := exec.CommandContext(ctx, "uv", "run", "aicp-matching-v2", "train", "--input", prepared.DatasetPath, "--artifact-dir", t.ArtifactDir)
	command.Dir = t.ServiceDir
	cache := t.UVCacheDir
	if cache == "" {
		cache = "/tmp/aicp-matching-v2-uv-cache"
	}
	command.Env = append(os.Environ(), "UV_CACHE_DIR="+cache)
	output, err := command.Output()
	if err != nil {
		return TrainedModel{}, fmt.Errorf("matching trainer failed: %w", err)
	}
	var model TrainedModel
	if err = json.Unmarshal(output, &model); err != nil {
		return TrainedModel{}, fmt.Errorf("decode matching trainer result: %w", err)
	}
	// Python 不知道数据库 run ID，由 Activity 在可信边界补入；样本数和来源仍必须与
	// Prepare 阶段完全一致，防止路径错配后把另一份数据的制品注册到当前运行。
	model.RunID = prepared.RunID
	if model.SampleCount != prepared.SampleCount || model.DataOrigin != prepared.DataOrigin {
		return TrainedModel{}, errors.New("matching trainer metadata does not match prepared dataset")
	}
	return model, nil
}
