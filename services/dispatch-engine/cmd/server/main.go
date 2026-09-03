package main

import (
	"context"
	"errors"
	"log"
	"net/http"
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
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
	queueadapter "github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/queue"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/store"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/tasktransition"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/webhook"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/kms"
	"github.com/aws/aws-sdk-go/service/sqs"
	"github.com/jackc/pgx/v5/pgxpool"
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
	businessAPIURL, err := requiredEnv("BUSINESS_API_URL")
	if err != nil {
		return err
	}
	publicDispatchURL, err := requiredEnv("DISPATCH_PUBLIC_URL")
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
	assignmentRepository := &store.AssignmentRepository{Pool: pool}
	dispatcher := &dispatch.Service{Repository: assignmentRepository, Queue: transport.queue}
	initialMatchCoordinator := &matching.InitialMatchCoordinator{Matcher: matcher, Dispatcher: dispatcher}
	initialMatchWorker := &matching.InitialMatchWorker{Source: matchingRepository, Runner: initialMatchCoordinator, Limit: 50}
	workflowMatchWorker := &matching.WorkflowInitialMatchWorker{Source: matchingRepository, Runner: initialMatchCoordinator, Limit: 50}
	transitionWorker := &tasktransition.Worker{
		Repository: &store.TaskTransitionRepository{Pool: pool},
		Sender: &tasktransition.HTTPSender{
			BaseURL: businessAPIURL,
			Token:   internalToken,
			Client:  &http.Client{Timeout: 10 * time.Second},
		},
		Lease: 30 * time.Second,
	}
	workflowTransitionWorker := &tasktransition.Worker{
		Repository: &store.WorkflowNodeTransitionRepository{Pool: pool},
		Sender: &tasktransition.HTTPSender{
			BaseURL: businessAPIURL,
			Token:   internalToken,
			Client:  &http.Client{Timeout: 10 * time.Second},
		},
		Lease: 30 * time.Second,
	}
	executionClient := &executionproxy.Client{
		BaseURL: businessAPIURL, Token: internalToken, HTTP: &http.Client{Timeout: 30 * time.Second},
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
	verifier := &protocol.Verifier{
		Keys:   store.CredentialKeyResolver{Pool: pool, Decryptor: transport.decryptor},
		Nonces: store.NonceRepository{Pool: pool},
	}
	api := &httpapi.Server{
		InternalToken: internalToken, Matcher: matcher, Dispatcher: dispatcher,
		AssignmentReader: assignmentRepository, AgentLifecycle: &store.AgentLifecycleRepository{Pool: pool}, Verifier: verifier,
		ExecutionProxy: executionClient,
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

	// Escrow 确认后 Business API 只推进权威任务状态；首轮候选由本 worker 持久化生成。
	// 失败不会丢任务：没有候选记录的 matching 任务会在下一秒再次被扫描。
	initialMatchingDone := make(chan struct{})
	go func() {
		defer close(initialMatchingDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			if _, matchErr := initialMatchWorker.RunOnce(ctx); matchErr != nil && !errors.Is(matchErr, context.Canceled) {
				log.Printf("initial task matching had failures")
			}
			if _, matchErr := workflowMatchWorker.RunOnce(ctx); matchErr != nil && !errors.Is(matchErr, context.Canceled) {
				log.Printf("workflow node matching had failures")
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

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
		<-transitionDone
		<-deliveryDone
		<-webhookDone
		<-healthDone
		<-initialMatchingDone
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
		awsSession, err := session.NewSession(&aws.Config{Region: aws.String(region)})
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
