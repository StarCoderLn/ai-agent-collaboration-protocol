package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agenthealth"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/credentials"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/delivery"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/executionproxy"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/httpapi"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matchingfeedback"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matchingv2"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
	queueadapter "github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/queue"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/sandboxadmission"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/semanticmatching"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/store"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/tasktransition"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/temporaladmission"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/temporaltraining"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/webhook"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/kms"
	"github.com/aws/aws-sdk-go/service/sqs"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.temporal.io/sdk/activity"
	temporalclient "go.temporal.io/sdk/client"
	temporalworker "go.temporal.io/sdk/worker"
	temporalworkflow "go.temporal.io/sdk/workflow"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Printf("dispatch engine stopped: %v", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	databaseURL, err := requiredEnv("DATABASE_URL")
	if err != nil {
		return err
	}
	internalToken, err := requiredEnv("DISPATCH_INTERNAL_TOKEN")
	if err != nil {
		return err
	}
	marketplaceAPIURL, err := requiredEnv("MARKETPLACE_API_URL")
	if err != nil {
		return err
	}
	publicDispatchURL, err := requiredEnv("DISPATCH_PUBLIC_URL")
	if err != nil {
		return err
	}
	admissionEnabled, err := booleanEnvOrDefault("AGENT_ADMISSION_ENABLED", true)
	if err != nil {
		return err
	}
	evaluatorAPIKey := ""
	if admissionEnabled {
		evaluatorAPIKey, err = requiredEnv("DEEPSEEK_API_KEY")
		if err != nil {
			return err
		}
	}
	admissionEngine, err := admissionEngineFromEnvironment(admissionEnabled)
	if err != nil {
		return err
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		return errors.New("postgres is unavailable")
	}

	transport, err := createTransport()
	if err != nil {
		return err
	}
	matchingRepository := &store.MatchingRepository{Pool: pool}
	matcher := &matching.Service{Repository: matchingRepository}
	semanticEnabled, err := booleanEnvOrDefault("MATCHING_SEMANTIC_ENABLED", false)
	if err != nil {
		return err
	}
	if semanticEnabled {
		openAIKey, keyErr := requiredEnv("OPENAI_API_KEY")
		if keyErr != nil {
			return keyErr
		}
		semanticConfig := semanticmatching.Config{
			Model: semanticmatching.DefaultModel, Dimensions: semanticmatching.DefaultDimensions,
			TopK: semanticmatching.DefaultTopK,
		}
		matcher.Semantic = &semanticmatching.Service{
			Embedder: &semanticmatching.OpenAIEmbedder{
				Client: &http.Client{Timeout: 15 * time.Second}, BaseURL: envOrDefault("OPENAI_BASE_URL", "https://api.openai.com/v1"),
				APIKey: openAIKey, Model: semanticConfig.Model, Dimensions: semanticConfig.Dimensions,
			},
			Store: &semanticmatching.PostgresStore{Pool: pool}, Config: semanticConfig,
		}
	}
	matchingV2Mode, err := matchingV2ModeFromEnvironment(matcher.Semantic != nil)
	if err != nil {
		return err
	}
	var matchingV2Worker *matchingv2.Worker
	if matchingV2Mode == "shadow" {
		modelURL, modelURLErr := requiredEnv("MATCHING_V2_MODEL_URL")
		if modelURLErr != nil {
			return modelURLErr
		}
		modelVersion, modelVersionErr := requiredEnv("MATCHING_V2_MODEL_VERSION")
		if modelVersionErr != nil {
			return modelVersionErr
		}
		scorer := &matchingv2.HTTPScorer{BaseURL: modelURL, Client: &http.Client{Timeout: 10 * time.Second}}
		if healthErr := scorer.CheckHealth(ctx, modelVersion); healthErr != nil {
			return errors.New("matching V2 model is unavailable or has a different version")
		}
		if promoteErr := (&store.MatchingTrainingRepository{Pool: pool}).PromoteShadowModel(ctx, modelVersion, time.Now().UTC()); promoteErr != nil {
			return promoteErr
		}
		matchingV2Worker = &matchingv2.Worker{
			Repository: &store.MatchingV2Repository{Pool: pool}, Scorer: scorer,
			Lease: 30 * time.Second,
		}
	}
	if matchingV2Mode == "online" {
		modelURL, modelURLErr := requiredEnv("MATCHING_V2_MODEL_URL")
		if modelURLErr != nil {
			return modelURLErr
		}
		modelVersion, modelVersionErr := requiredEnv("MATCHING_V2_MODEL_VERSION")
		if modelVersionErr != nil {
			return modelVersionErr
		}
		// HTTP /health 只能证明某个制品正在运行，不能证明它获准接管真实流量。先从
		// PostgreSQL 注册表校验 active + real + 特征版本，再核对进程实际加载版本；
		// synthetic/shadow 制品即使服务完全健康，也不能进入正式 Top-3。
		modelRegistry := &store.MatchingTrainingRepository{Pool: pool}
		if releaseErr := modelRegistry.RequireActiveRealModel(ctx, modelVersion, matchingv2.FeatureSchemaVersion); releaseErr != nil {
			return errors.New("matching V2 online model is not an approved active real-data release")
		}
		scorer := &matchingv2.HTTPScorer{BaseURL: modelURL, Client: &http.Client{Timeout: 10 * time.Second}}
		if healthErr := scorer.CheckHealth(ctx, modelVersion); healthErr != nil {
			return errors.New("matching V2 online model is unavailable or has a different version")
		}
		matcher.Ranker = &matchingv2.OnlineRanker{Scorer: scorer, Version: modelVersion}
		matcher.RequireV2 = true
	}
	assignmentRepository := &store.AssignmentRepository{Pool: pool}
	dispatcher := &dispatch.Service{Repository: assignmentRepository, Queue: transport.queue}
	initialMatchCoordinator := &matching.InitialMatchCoordinator{Matcher: matcher, Dispatcher: dispatcher}
	initialMatchWorker := &matching.InitialMatchWorker{Source: matchingRepository, Runner: initialMatchCoordinator, Limit: 50}
	workflowMatchWorker := &matching.WorkflowInitialMatchWorker{Source: matchingRepository, Runner: initialMatchCoordinator, Limit: 50}
	transitionWorker := &tasktransition.Worker{
		Repository: &store.TaskTransitionRepository{Pool: pool},
		Sender: &tasktransition.HTTPSender{
			BaseURL: marketplaceAPIURL,
			Token:   internalToken,
			Client:  &http.Client{Timeout: 10 * time.Second},
		},
		Lease: 30 * time.Second,
	}
	workflowTransitionWorker := &tasktransition.Worker{
		Repository: &store.WorkflowNodeTransitionRepository{Pool: pool},
		Sender: &tasktransition.HTTPSender{
			BaseURL: marketplaceAPIURL,
			Token:   internalToken,
			Client:  &http.Client{Timeout: 10 * time.Second},
		},
		Lease: 30 * time.Second,
	}
	executionClient := &executionproxy.Client{
		BaseURL: marketplaceAPIURL, Token: internalToken, HTTP: &http.Client{Timeout: 30 * time.Second},
	}
	deliveryConsumer := &delivery.Consumer{
		Source: transport.source,
		Processor: &delivery.ProcessorService{
			Repository: &store.AgentDeliveryRepository{
				Pool: pool, Decryptor: transport.decryptor, CallbackBaseURL: strings.TrimSuffix(publicDispatchURL, "/"),
			},
			Caller:       &delivery.HTTPAgentCaller{Client: &http.Client{Timeout: 20 * time.Second}},
			Acknowledger: dispatcher,
			Submitter:    executionClient,
		},
	}
	webhookWorker := &webhook.Worker{
		Repository: &store.WebhookRepository{Pool: pool, CallbackBaseURL: strings.TrimSuffix(publicDispatchURL, "/")},
		Decryptor:  transport.decryptor,
		Sender:     &webhook.HTTPSender{Client: &http.Client{Timeout: 20 * time.Second}},
		Lease:      30 * time.Second,
	}
	healthWorker := &agenthealth.Worker{
		Repository: &store.AgentHealthRepository{Pool: pool},
		Decryptor:  transport.decryptor,
		Prober:     &agenthealth.HTTPProber{Client: &http.Client{Timeout: 10 * time.Second}},
		Lease:      30 * time.Second,
	}
	automaticAdmissionRepository := &store.AutomaticAdmissionRepository{Pool: pool}
	automaticAdmissionWorker := &sandboxadmission.Worker{
		Repository: automaticAdmissionRepository,
		Sandbox: &sandboxadmission.Service{
			Repository: &store.SandboxAdmissionRepository{Pool: pool},
			Decryptor:  transport.decryptor,
			// 生成类 Agent 可能需要完成真实图片、PPT 或论文产物，不能复用健康探测的
			// 10 秒超时；每个测试任务仍由轮次总租约限制，避免无限占用 Worker。
			Caller: &sandboxadmission.HTTPCaller{Client: &http.Client{Timeout: 3 * time.Minute}},
			Lease:  4 * time.Minute,
		},
		Evaluator: &sandboxadmission.OpenAICompatibleEvaluator{
			Client:  &http.Client{Timeout: 2 * time.Minute},
			BaseURL: envOrDefault("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
			APIKey:  evaluatorAPIKey,
			Model:   envOrDefault("AGENT_ADMISSION_EVALUATOR_MODEL", "deepseek-chat"),
		},
		Lifecycle: &store.AgentLifecycleRepository{Pool: pool},
		Lease:     15 * time.Minute,
	}
	matchingTrainingEnabled, err := booleanEnvOrDefault("MATCHING_V2_TRAINING_ENABLED", false)
	if err != nil {
		return err
	}
	var temporalClient temporalclient.Client
	var admissionTemporalWorker temporalworker.Worker
	var trainingTemporalWorker temporalworker.Worker
	var temporalStarter *temporaladmission.Starter
	if admissionEngine == "temporal" || matchingTrainingEnabled {
		temporalClient, err = temporalclient.Dial(temporalclient.Options{
			HostPort:  envOrDefault("TEMPORAL_ADDRESS", temporalclient.DefaultHostPort),
			Namespace: envOrDefault("TEMPORAL_NAMESPACE", temporalclient.DefaultNamespace),
		})
		if err != nil {
			return errors.New("temporal is unavailable")
		}
		defer temporalClient.Close()
	}
	if admissionEngine == "temporal" {
		taskQueue := envOrDefault("TEMPORAL_ADMISSION_TASK_QUEUE", temporaladmission.DefaultTaskQueue)
		admissionTemporalWorker = temporalworker.New(temporalClient, taskQueue, temporalworker.Options{})
		admissionTemporalWorker.RegisterWorkflowWithOptions(temporaladmission.AdmissionWorkflow, temporalworkflow.RegisterOptions{Name: temporaladmission.WorkflowName})
		activities := &temporaladmission.Activities{
			Repository: automaticAdmissionRepository, Sandbox: automaticAdmissionWorker.Sandbox,
			Evaluator: automaticAdmissionWorker, Lifecycle: automaticAdmissionWorker.Lifecycle,
		}
		admissionTemporalWorker.RegisterActivityWithOptions(activities.RunSandbox, activity.RegisterOptions{Name: temporaladmission.RunSandboxActivityName})
		admissionTemporalWorker.RegisterActivityWithOptions(activities.Evaluate, activity.RegisterOptions{Name: temporaladmission.EvaluateActivityName})
		admissionTemporalWorker.RegisterActivityWithOptions(activities.ApplyDecision, activity.RegisterOptions{Name: temporaladmission.ApplyDecisionActivityName})
		admissionTemporalWorker.RegisterActivityWithOptions(activities.ReleaseRound, activity.RegisterOptions{Name: temporaladmission.ReleaseRoundActivityName})
		if err = admissionTemporalWorker.Start(); err != nil {
			return err
		}
		defer admissionTemporalWorker.Stop()
		temporalStarter = &temporaladmission.Starter{
			Repository: automaticAdmissionRepository, Client: temporalClient, TaskQueue: taskQueue,
		}
	}
	if matchingTrainingEnabled {
		serviceDir, pathErr := requiredEnv("MATCHING_V2_SERVICE_DIR")
		if pathErr != nil {
			return pathErr
		}
		workDir, pathErr := requiredEnv("MATCHING_V2_TRAINING_WORK_DIR")
		if pathErr != nil {
			return pathErr
		}
		artifactDir, pathErr := requiredEnv("MATCHING_V2_ARTIFACT_DIR")
		if pathErr != nil {
			return pathErr
		}
		taskQueue := envOrDefault("MATCHING_V2_TRAINING_TASK_QUEUE", temporaltraining.DefaultTaskQueue)
		trainingRepository := &store.MatchingTrainingRepository{Pool: pool}
		trainingActivities := &temporaltraining.Activities{
			Repository: trainingRepository, WorkDir: workDir,
			Trainer: temporaltraining.CommandTrainer{ServiceDir: serviceDir, ArtifactDir: artifactDir},
		}
		trainingTemporalWorker = temporalworker.New(temporalClient, taskQueue, temporalworker.Options{})
		trainingTemporalWorker.RegisterWorkflowWithOptions(temporaltraining.TrainingWorkflow, temporalworkflow.RegisterOptions{Name: temporaltraining.WorkflowName})
		trainingTemporalWorker.RegisterActivityWithOptions(trainingActivities.PrepareDataset, activity.RegisterOptions{Name: temporaltraining.PrepareActivityName})
		trainingTemporalWorker.RegisterActivityWithOptions(trainingActivities.TrainModel, activity.RegisterOptions{Name: temporaltraining.TrainActivityName})
		trainingTemporalWorker.RegisterActivityWithOptions(trainingActivities.RegisterModel, activity.RegisterOptions{Name: temporaltraining.RegisterActivityName})
		trainingTemporalWorker.RegisterActivityWithOptions(trainingActivities.FailTraining, activity.RegisterOptions{Name: temporaltraining.FailActivityName})
		if err = trainingTemporalWorker.Start(); err != nil {
			return err
		}
		defer trainingTemporalWorker.Stop()
		if err = temporaltraining.EnsureNightlySchedule(ctx, temporalClient.ScheduleClient(), taskQueue, 90); err != nil {
			return err
		}
	}
	verifier := &protocol.Verifier{
		Keys:   store.CredentialKeyResolver{Pool: pool, Decryptor: transport.decryptor},
		Nonces: store.NonceRepository{Pool: pool},
	}
	api := &httpapi.Server{
		InternalToken: internalToken, Matcher: matcher, Dispatcher: dispatcher,
		AssignmentReader: assignmentRepository,
		MatchingFeedback: &matchingfeedback.Service{Repository: &store.MatchingFeedbackRepository{Pool: pool}},
		AgentLifecycle:   &store.AgentLifecycleRepository{Pool: pool}, Verifier: verifier,
		ExecutionProxy: executionClient, AdmissionRetry: automaticAdmissionRepository,
	}
	address := envOrDefault("DISPATCH_HTTP_ADDRESS", "127.0.0.1:3200")
	server := &http.Server{
		Addr: address, Handler: api.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
	}

	// 超时扫描只更新 assignment 并写 transition outbox，不直接修改任务主状态。
	scannerDone := make(chan struct{})
	go func() {
		defer close(scannerDone)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		scanTick := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				scanTick++
				if _, scanErr := dispatcher.ExpireDue(ctx, 100); scanErr != nil && !errors.Is(scanErr, context.Canceled) {
					log.Printf("assignment expiry scan failed") // 不记录请求体、签名或凭证明文。
				}
				if scanErr := executionClient.RunTimeoutScan(ctx, 100); scanErr != nil && !errors.Is(scanErr, context.Canceled) {
					log.Printf("task execution timeout scan failed")
				}
				// 评分不需要跟超时扫描一样频繁；五分钟一次避免无意义堆积近似快照。
				if scanTick%10 == 0 {
					if scanErr := executionClient.RunScoreSnapshot(ctx, 500); scanErr != nil && !errors.Is(scanErr, context.Canceled) {
						log.Printf("agent score snapshot scan failed")
					}
				}
			}
		}
	}()

	// 评分、结算和仲裁事件会在原业务事务内合并为 Agent 刷新请求。短周期 worker 仅处理
	// 这些受影响的 Agent；上面的周期扫描继续校准时间衰减并恢复任何遗漏请求。
	scoreRefreshDone := make(chan struct{})
	go func() {
		defer close(scoreRefreshDone)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			if refreshErr := executionClient.RunScoreRefresh(ctx, 100); refreshErr != nil && !errors.Is(refreshErr, context.Canceled) {
				log.Printf("agent score event refresh failed")
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	// SQS 长轮询最多等待 10 秒；取消 context 会立即结束等待。消息体和 Agent 响应均不
	// 写日志，失败只保留稳定 error_code 到 dispatch_attempts。
	deliveryDone := make(chan struct{})
	go func() {
		defer close(deliveryDone)
		for ctx.Err() == nil {
			if _, deliveryErr := deliveryConsumer.RunOnce(ctx, 10, 10*time.Second); deliveryErr != nil && !errors.Is(deliveryErr, context.Canceled) {
				log.Printf("agent dispatch delivery had failures")
			}
		}
	}()

	// outbox worker 把 Go 已提交的派发事实交给 TypeScript 权威状态机。这里只记录错误
	// 类别，不输出事件 payload、Agent 凭证或内部 service token。
	transitionDone := make(chan struct{})
	go func() {
		defer close(transitionDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			if _, transitionErr := transitionWorker.RunOnce(ctx, 50); transitionErr != nil && !errors.Is(transitionErr, context.Canceled) {
				log.Printf("task transition delivery had failures")
			}
			if _, transitionErr := workflowTransitionWorker.RunOnce(ctx, 100); transitionErr != nil && !errors.Is(transitionErr, context.Canceled) {
				log.Printf("workflow node transition delivery had failures")
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	// Webhook 与 SSE 读取同一条 task_events 事实。worker 只消费事务内创建的 outbox，
	// 因而进程崩溃、超时或 Agent 暂时离线都不会丢事件；死信只记录稳定错误码。
	webhookDone := make(chan struct{})
	go func() {
		defer close(webhookDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			result, webhookErr := webhookWorker.RunOnce(ctx, 50)
			if webhookErr != nil && !errors.Is(webhookErr, context.Canceled) {
				log.Printf("task webhook delivery had failures")
			}
			if result.DeadLetters > 0 {
				log.Printf("task webhook deliveries reached dead letter: count=%d", result.DeadLetters)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	// 每 30 秒只扫描“到期”的 Agent；每个 Agent 的真实探测间隔来自数据库配置，
	// 默认五分钟。持久化租约允许多实例部署，旧实例超时完成也不能覆盖新实例结果。
	healthDone := make(chan struct{})
	go func() {
		defer close(healthDone)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			result, healthErr := healthWorker.RunOnce(ctx, 50)
			if healthErr != nil && !errors.Is(healthErr, context.Canceled) {
				log.Printf("agent health probe batch had failures")
			}
			if result.Transitions > 0 {
				log.Printf("agent health lifecycle transitions: count=%d", result.Transitions)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	// 新 Agent 无需等待人工审核：Worker 自动补建初始轮次，并串行完成三次隔离调用和
	// 一次批量质量评测。所有运行状态都在数据库中，进程退出后下一实例会从租约恢复。
	admissionDone := make(chan struct{})
	if admissionEngine != "disabled" {
		go func() {
			defer close(admissionDone)
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			for {
				var processed, passed bool
				var admissionErr error
				if admissionEngine == "temporal" {
					result, startErr := temporalStarter.RunOnce(ctx, 50)
					processed, admissionErr = result.Started, startErr
				} else {
					result, workerErr := automaticAdmissionWorker.RunOnce(ctx, 50)
					processed, passed, admissionErr = result.Processed, result.Passed, workerErr
				}
				if admissionErr != nil && !errors.Is(admissionErr, context.Canceled) {
					// 不记录测试任务、Agent 产物或评测响应，防止不可信内容进入基础日志。
					log.Printf("automatic agent admission had a recoverable failure")
				}
				if processed {
					if admissionEngine == "temporal" {
						log.Printf("automatic agent admission workflow started")
					} else {
						log.Printf("automatic agent admission completed: passed=%t", passed)
					}
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	} else {
		// 仅供不允许产生外部 Agent/模型费用的本地页面检查使用。生产默认开启；关闭时
		// 不创建或推进任何轮次，因此重新开启后仍会从数据库中的真实状态继续。
		close(admissionDone)
	}

	// Escrow 确认后 Marketplace API 只推进权威任务状态；首轮候选由本 worker 持久化生成。
	// 失败不会丢任务：没有候选记录的 matching 任务会在下一秒再次被扫描。
	initialMatchingDone := make(chan struct{})
	go func() {
		defer close(initialMatchingDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			if _, matchErr := initialMatchWorker.RunOnce(ctx); matchErr != nil && !errors.Is(matchErr, context.Canceled) {
				// 记录内部错误链，便于区分数据损坏、迁移遗漏和临时基础设施故障；
				// 日志不包含任务正文、凭据或 Agent 密钥，避免为了可观测性泄露敏感信息。
				log.Printf("initial task matching had failures: %v", matchErr)
			}
			if _, matchErr := workflowMatchWorker.RunOnce(ctx); matchErr != nil && !errors.Is(matchErr, context.Canceled) {
				log.Printf("workflow node matching had failures: %v", matchErr)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	// V2 独立消费私有召回池。没有影子模型时仓储不会领取任务；模型不可用时只记录
	// 有上限的重试证据，不阻塞上面的 V0/V1 正式匹配和派发 worker。
	matchingV2Done := make(chan struct{})
	if matchingV2Worker != nil {
		go func() {
			defer close(matchingV2Done)
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				if _, shadowErr := matchingV2Worker.RunOnce(ctx); shadowErr != nil && !errors.Is(shadowErr, context.Canceled) {
					log.Printf("matching V2 shadow worker had a recoverable failure")
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	} else {
		close(matchingV2Done)
	}

	serverError := make(chan error, 1)
	go func() {
		log.Printf("dispatch engine listening on %s", address)
		serverError <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err = server.Shutdown(shutdownContext); err != nil {
			return err
		}
		<-scannerDone
		<-scoreRefreshDone
		<-transitionDone
		<-deliveryDone
		<-webhookDone
		<-healthDone
		<-admissionDone
		<-initialMatchingDone
		<-matchingV2Done
		return nil
	case err = <-serverError:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

type dispatchTransport struct {
	queue     dispatch.Queue
	source    delivery.Source
	decryptor store.CredentialDecryptor
}

/**
 * createTransport 把 AWS 与本地体验差异收进一个启动边界。领域派发、签名、回执和状态
 * 迁移在两种模式下完全相同，避免“本地模式”演变成另一套不可上线的业务逻辑。
 */
func createTransport() (dispatchTransport, error) {
	switch envOrDefault("DISPATCH_QUEUE_MODE", "sqs") {
	case "local":
		secret, err := requiredEnv("LOCAL_AGENT_SECRET")
		if err != nil {
			return dispatchTransport{}, err
		}
		memory, err := queueadapter.NewMemory(1024)
		if err != nil {
			return dispatchTransport{}, err
		}
		return dispatchTransport{queue: memory, source: memory, decryptor: credentials.LocalDecryptor{Secret: secret}}, nil
	case "sqs":
		queueURL, err := requiredEnv("DISPATCH_SQS_QUEUE_URL")
		if err != nil {
			return dispatchTransport{}, err
		}
		region, err := requiredEnv("AWS_REGION")
		if err != nil {
			return dispatchTransport{}, err
		}
		awsConfig, err := awsConfigFromEnvironment(region)
		if err != nil {
			return dispatchTransport{}, err
		}
		awsSession, err := session.NewSession(awsConfig)
		if err != nil {
			return dispatchTransport{}, err
		}
		client := sqs.New(awsSession)
		return dispatchTransport{
			queue:     &queueadapter.SQS{Client: client, QueueURL: queueURL},
			source:    &queueadapter.SQSReceiver{Client: client, QueueURL: queueURL},
			decryptor: credentials.EnvelopeDecryptor{KMS: kms.New(awsSession)},
		}, nil
	default:
		return dispatchTransport{}, errors.New("DISPATCH_QUEUE_MODE must be local or sqs")
	}
}

// awsConfigFromEnvironment 是 Dispatch Engine 连接 AWS 兼容服务的唯一入口。
// 生产不设 AWS_ENDPOINT_URL，SDK 按 region 访问真实 AWS；LocalStack 模式显式
// 注入本机 endpoint，SQS 与 KMS 仍复用同一组领域适配器和失败语义。
func awsConfigFromEnvironment(region string) (*aws.Config, error) {
	config := &aws.Config{Region: aws.String(region)}
	endpoint := strings.TrimSpace(os.Getenv("AWS_ENDPOINT_URL"))
	if endpoint == "" {
		return config, nil
	}
	parsed, err := url.ParseRequestURI(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("AWS_ENDPOINT_URL must be an absolute http or https URL")
	}
	config.Endpoint = aws.String(strings.TrimRight(endpoint, "/"))
	return config, nil
}

func requiredEnv(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", errors.New(name + " is required")
	}
	return value, nil
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func booleanEnvOrDefault(name string, fallback bool) (bool, error) {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	if value == "" {
		return fallback, nil
	}
	if value == "true" {
		return true, nil
	}
	if value == "false" {
		return false, nil
	}
	return false, errors.New(name + " must be true or false")
}

func admissionEngineFromEnvironment(enabled bool) (string, error) {
	if !enabled {
		return "disabled", nil
	}
	engine := envOrDefault("AGENT_ADMISSION_ENGINE", "postgres")
	if engine != "postgres" && engine != "temporal" {
		return "", errors.New("AGENT_ADMISSION_ENGINE must be postgres or temporal")
	}
	return engine, nil
}

// matchingV2ModeFromEnvironment 把两个布尔开关收敛为一个互斥运行模式。
// shadow 只记录对照结果，允许 synthetic 制品做工程验收；online 会改变真实
// Top-3，因此必须同时启用 pgvector 语义召回，并在启动分支内通过 active + real
// 数据库发布门禁。这里先拒绝双开，避免同一进程既写影子结果又接管正式流量。
func matchingV2ModeFromEnvironment(semanticEnabled bool) (string, error) {
	shadowEnabled, err := booleanEnvOrDefault("MATCHING_V2_SHADOW_ENABLED", false)
	if err != nil {
		return "", err
	}
	onlineEnabled, err := booleanEnvOrDefault("MATCHING_V2_ONLINE_ENABLED", false)
	if err != nil {
		return "", err
	}
	if shadowEnabled && onlineEnabled {
		return "", errors.New("matching V2 shadow and online modes cannot be enabled together")
	}
	if onlineEnabled && !semanticEnabled {
		return "", errors.New("matching V2 online mode requires semantic retrieval")
	}
	if onlineEnabled {
		return "online", nil
	}
	if shadowEnabled {
		return "shadow", nil
	}
	return "disabled", nil
}
